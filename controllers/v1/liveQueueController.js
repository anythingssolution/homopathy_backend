const { query, withTransaction } = require('../../config/db');
const AppError = require('../../utils/AppError');
const asyncHandler = require('../../utils/asyncHandler');
const {
    QUEUE_STATUS,
    SESSION_STATUS,
    ACTIVE_QUEUE_STATUSES,
    READY_QUEUE_STATUSES,
    isValidDateString,
    toPositiveInt,
    listBranchSlotBlockContexts,
    getSlotQueueContext,
    ensureQueueSession,
    logQueueEvent,
    recalculateQueuePlan,
    recalculateLiveRuntimeProjection,
    formatDateTimeForSql,
    getLiveQueueSnapshot,
    getCurrentDateTokenList,
    emitLiveQueueEvent,
    compareReadyQueueItems,
    autoSelectAndCallNextReady,
} = require('../../services/liveQueueService');
const {
    scheduleAutoCallNext,
    cancelScheduledAutoCallNext,
    DEFAULT_AUTO_CALL_DELAY_MS,
} = require('../../services/liveQueueAutomationService');

const getClientIp = (req) => {
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) {
        return forwarded.split(',')[0].trim();
    }

    return req.ip || req.socket?.remoteAddress || '0.0.0.0';
};

const getActorUserId = (req) => req.user?.id || null;
const PROTECTED_VISIBLE_QUEUE_WINDOW_SIZE = 5;

const extractProtectedVisibleWindowAppointmentIds = (snapshot = {}) => {
    const orderedItems = Array.isArray(snapshot.service_pipeline) && snapshot.service_pipeline.length > 0
        ? snapshot.service_pipeline
        : [
            snapshot.current_running_token,
            snapshot.next_in_line_token,
            ...(Array.isArray(snapshot.ready_queue) ? snapshot.ready_queue : []),
            ...(Array.isArray(snapshot.hold_queue)
                ? snapshot.hold_queue.filter((item) => item?.present_now || item?.checked_in_at)
                : []),
        ];
    const seenAppointmentIds = new Set();
    const appointmentIds = [];

    for (const item of orderedItems) {
        const appointmentId = Number(item?.appointment_id || 0);

        if (!Number.isInteger(appointmentId) || appointmentId <= 0 || seenAppointmentIds.has(appointmentId)) {
            continue;
        }

        seenAppointmentIds.add(appointmentId);
        appointmentIds.push(appointmentId);

        if (appointmentIds.length >= PROTECTED_VISIBLE_QUEUE_WINDOW_SIZE) {
            break;
        }
    }

    return appointmentIds;
};

const getNextArrivalSequence = async (connection, {
    branchId,
    slotId,
    appointmentDate,
}) => {
    const [rows] = await connection.execute(
        `SELECT arrival_sequence
         FROM tbl_appointments
         WHERE fk_branch_id = ?
           AND fk_slot_id = ?
           AND appointment_date = ?
           AND arrival_sequence IS NOT NULL
         ORDER BY arrival_sequence DESC
         LIMIT 1
         FOR UPDATE`,
        [branchId, slotId, appointmentDate]
    );

    return Number(rows[0]?.arrival_sequence || 0) + 1;
};

const assertQueueSessionCanAdvance = async (connection, {
    branchId,
    slotId,
    appointmentDate,
}) => {
    const [rows] = await connection.execute(
        `SELECT session_status
         FROM tbl_live_queue_sessions
         WHERE fk_branch_id = ?
           AND fk_slot_id = ?
           AND appointment_date = ?
         LIMIT 1`,
        [branchId, slotId, appointmentDate]
    );

    const sessionStatus = rows[0]?.session_status || SESSION_STATUS.NOT_STARTED;

    if (sessionStatus === SESSION_STATUS.NOT_STARTED) {
        throw new AppError('Doctor session not started. Start session before advancing queue.', 409);
    }

    if (sessionStatus === SESSION_STATUS.PAUSED) {
        throw new AppError('Queue is paused. Resume session before advancing queue.', 409);
    }

};

const getLiveQueue = asyncHandler(async (req, res) => {
    const slotId = toPositiveInt(req.params.slot_id);
    const branchId = req.query.branch_id !== undefined ? toPositiveInt(req.query.branch_id) : null;
    const appointmentDate = req.query.appointment_date ? String(req.query.appointment_date).trim() : null;

    if (!slotId) {
        throw new AppError('Valid slot_id is required', 400);
    }

    if (req.query.branch_id !== undefined && !branchId) {
        throw new AppError('branch_id must be a positive integer', 400);
    }

    if (appointmentDate && !isValidDateString(appointmentDate)) {
        throw new AppError('appointment_date must be in YYYY-MM-DD format', 400);
    }

    const snapshot = await getLiveQueueSnapshot({
        branchId,
        slotId,
        appointmentDate,
    });

    return res.status(200).json({
        success: true,
        message: 'Live queue fetched successfully',
        data: snapshot,
    });
});

const listCurrentDateTokens = asyncHandler(async (req, res) => {
    const branchId = req.query.branch_id !== undefined ? toPositiveInt(req.query.branch_id) : null;
    const slotId = req.query.slot_id !== undefined ? toPositiveInt(req.query.slot_id) : null;
    const appointmentDate = req.query.appointment_date ? String(req.query.appointment_date).trim() : null;

    if (req.query.branch_id !== undefined && !branchId) {
        throw new AppError('branch_id must be a positive integer', 400);
    }

    if (req.query.slot_id !== undefined && !slotId) {
        throw new AppError('slot_id must be a positive integer', 400);
    }

    if (appointmentDate && !isValidDateString(appointmentDate)) {
        throw new AppError('appointment_date must be in YYYY-MM-DD format', 400);
    }

    const data = await getCurrentDateTokenList({
        branchId,
        slotId,
        appointmentDate,
    });

    return res.status(200).json({
        success: true,
        message: 'Current date tokens fetched successfully',
        data,
    });
});

const listReplayEvents = asyncHandler(async (req, res) => {
    const branchId = req.query.branch_id !== undefined ? toPositiveInt(req.query.branch_id) : null;
    const slotId = req.query.slot_id !== undefined ? toPositiveInt(req.query.slot_id) : null;
    const appointmentDate = req.query.appointment_date ? String(req.query.appointment_date).trim() : null;
    const fromTime = req.query.from_time ? String(req.query.from_time).trim() : null;
    const limit = Math.min(toPositiveInt(req.query.limit) || 250, 1000);

    if (req.query.branch_id !== undefined && !branchId) {
        throw new AppError('branch_id must be a positive integer', 400);
    }

    if (req.query.slot_id !== undefined && !slotId) {
        throw new AppError('slot_id must be a positive integer', 400);
    }

    if (appointmentDate && !isValidDateString(appointmentDate)) {
        throw new AppError('appointment_date must be in YYYY-MM-DD format', 400);
    }

    let resolvedContext = {
        branch_id: branchId,
        slot_id: slotId,
        appointment_date: appointmentDate,
    };

    if (!branchId || !slotId || !appointmentDate) {
        const latestGroups = await query(
            `SELECT
                fk_branch_id AS branch_id,
                fk_slot_id AS slot_id,
                DATE_FORMAT(appointment_date, '%Y-%m-%d') AS appointment_date
             FROM tbl_appointment_queue_events
             GROUP BY fk_branch_id, fk_slot_id, appointment_date
             ORDER BY MAX(created_at) DESC
             LIMIT 1`
        );

        if (latestGroups.length > 0) {
            resolvedContext = latestGroups[0];
        }
    }

    if (!resolvedContext.branch_id || !resolvedContext.slot_id || !resolvedContext.appointment_date) {
        return res.status(200).json({
            success: true,
            message: 'No replay events found',
            data: {
                context: resolvedContext,
                events: [],
                totals: {},
            },
        });
    }

    const params = [
        resolvedContext.branch_id,
        resolvedContext.slot_id,
        resolvedContext.appointment_date,
    ];
    let fromClause = '';

    if (fromTime) {
        fromClause = 'AND e.created_at >= ?';
        params.push(fromTime);
    }

    params.push(limit);

    const events = await query(
        `SELECT
            e.id,
            e.appointment_id,
            e.fk_branch_id AS branch_id,
            e.fk_slot_id AS slot_id,
            DATE_FORMAT(e.appointment_date, '%Y-%m-%d') AS appointment_date,
            e.token_number,
            e.event_type,
            e.old_queue_status,
            e.new_queue_status,
            e.meta_json,
            e.created_by,
            DATE_FORMAT(e.created_at, '%Y-%m-%d %H:%i:%s') AS created_at,
            COALESCE(a.original_token_number, a.current_token_number, e.token_number) AS display_token_number,
            a.queue_status AS current_queue_status,
            DATE_FORMAT(a.planned_start_at, '%Y-%m-%d %H:%i:%s') AS planned_start_at,
            a.auid,
            p.full_name AS patient_full_name,
            COALESCE(u.full_name, u.mobile_no, CONCAT('User #', e.created_by)) AS actor_name,
            b.branch_name,
            s.slot_name
         FROM tbl_appointment_queue_events e
         LEFT JOIN tbl_appointments a ON a.appointment_id = e.appointment_id
         LEFT JOIN master_users p ON p.id = a.fk_patient_id
         LEFT JOIN master_users u ON u.id = e.created_by
         LEFT JOIN master_clinic_branches b ON b.id = e.fk_branch_id
         LEFT JOIN master_slots s ON s.id = e.fk_slot_id
         WHERE e.fk_branch_id = ?
           AND e.fk_slot_id = ?
           AND e.appointment_date = ?
           ${fromClause}
         ORDER BY e.created_at ASC, e.id ASC
         LIMIT ?`,
        params
    );

    const normalizedEvents = events.map((event) => {
        let meta = null;
        if (event.meta_json) {
            try {
                meta = JSON.parse(event.meta_json);
            } catch (error) {
                meta = { raw: event.meta_json };
            }
        }

        return {
            ...event,
            token_number: event.token_number === null ? null : Number(event.token_number),
            display_token_number: event.display_token_number === null ? null : Number(event.display_token_number),
            meta,
            meta_json: undefined,
        };
    });

    const totals = normalizedEvents.reduce((acc, event) => {
        acc[event.event_type] = (acc[event.event_type] || 0) + 1;
        return acc;
    }, {});

    return res.status(200).json({
        success: true,
        message: 'Replay events fetched successfully',
        data: {
            context: {
                ...resolvedContext,
                branch_id: Number(resolvedContext.branch_id),
                slot_id: Number(resolvedContext.slot_id),
                branch_name: normalizedEvents[0]?.branch_name || null,
                slot_name: normalizedEvents[0]?.slot_name || null,
            },
            events: normalizedEvents,
            totals,
        },
    });
});

const startDoctorSession = asyncHandler(async (req, res) => {
    const slotId = toPositiveInt(req.params.slot_id);
    const branchId = toPositiveInt(req.body?.branch_id || req.query?.branch_id);
    const appointmentDate = String(req.body?.appointment_date || req.query?.appointment_date || '').trim();

    if (!slotId || !branchId || !isValidDateString(appointmentDate)) {
        throw new AppError('slot_id, branch_id and appointment_date are required', 400);
    }

    const queueContext = await getSlotQueueContext({ slotId, branchId, appointmentDate });

    const actorUserId = getActorUserId(req);
    const actorIp = getClientIp(req);
    const blockContexts = await listBranchSlotBlockContexts({
        branchId: queueContext.branchId,
        appointmentDate: queueContext.appointmentDate,
        slotId: queueContext.slotId,
    });
    const relatedSlotContexts = blockContexts.slots.length > 0 ? blockContexts.slots : [queueContext];
    const startedSlotContexts = [];
    const autoCallStartContexts = [];

    for (const slotContext of relatedSlotContexts) {
        await cancelScheduledAutoCallNext({
            branchId: slotContext.branchId,
            slotId: slotContext.slotId,
            appointmentDate: slotContext.appointmentDate,
        });
    }

    await withTransaction(async (connection) => {
        for (const slotContext of relatedSlotContexts) {
            const session = await ensureQueueSession(connection, {
                branchId: slotContext.branchId,
                slotId: slotContext.slotId,
                appointmentDate: slotContext.appointmentDate,
                actorUserId,
            });

            await connection.execute(
                `UPDATE tbl_live_queue_sessions
                 SET session_status = ?,
                     session_started_at = COALESCE(session_started_at, NOW()),
                     session_ended_at = NULL,
                     updated_by = ?
                 WHERE fk_branch_id = ?
                   AND fk_slot_id = ?
                   AND appointment_date = ?`,
                [
                    SESSION_STATUS.RUNNING,
                    actorUserId,
                    slotContext.branchId,
                    slotContext.slotId,
                    slotContext.appointmentDate,
                ]
            );

            await logQueueEvent(connection, {
                branchId: slotContext.branchId,
                slotId: slotContext.slotId,
                appointmentDate: slotContext.appointmentDate,
                eventType: 'SESSION_STARTED',
                createdBy: actorUserId,
                meta: {
                    block_code: blockContexts.blockCode || null,
                    started_via_slot_id: queueContext.slotId,
                },
            });

            await recalculateLiveRuntimeProjection(connection, {
                branchId: slotContext.branchId,
                slotId: slotContext.slotId,
                appointmentDate: slotContext.appointmentDate,
                actorUserId,
                actorIp,
            });

            startedSlotContexts.push(slotContext);
            if (!session?.current_appointment_id) {
                autoCallStartContexts.push(slotContext);
            }
        }
    });

    for (const slotContext of autoCallStartContexts) {
        await scheduleAutoCallNext({
            branchId: slotContext.branchId,
            slotId: slotContext.slotId,
            appointmentDate: slotContext.appointmentDate,
            actorUserId,
            delayMs: DEFAULT_AUTO_CALL_DELAY_MS,
            reason: 'AUTO_CALL_NEXT_AFTER_SESSION_START',
        });
    }

    let payload = null;
    for (const slotContext of startedSlotContexts) {
        const emittedPayload = await emitLiveQueueEvent({
            branchId: slotContext.branchId,
            slotId: slotContext.slotId,
            appointmentDate: slotContext.appointmentDate,
            eventName: 'doctor-session-started',
            reason: 'SESSION_STARTED',
        });

        if (Number(slotContext.slotId) === Number(queueContext.slotId)) {
            payload = emittedPayload;
        }
    }

    payload = payload || await emitLiveQueueEvent({
        branchId: queueContext.branchId,
        slotId: queueContext.slotId,
        appointmentDate: queueContext.appointmentDate,
        eventName: 'doctor-session-started',
        reason: 'SESSION_STARTED',
    });

    return res.status(200).json({
        success: true,
        message: 'Doctor session started successfully',
        data: payload,
    });
});

const completeDoctorSession = asyncHandler(async (req, res) => {
    const slotId = toPositiveInt(req.params.slot_id);
    const branchId = toPositiveInt(req.body?.branch_id || req.query?.branch_id);
    const appointmentDate = String(req.body?.appointment_date || req.query?.appointment_date || '').trim();

    if (!slotId || !branchId || !isValidDateString(appointmentDate)) {
        throw new AppError('slot_id, branch_id and appointment_date are required', 400);
    }

    const queueContext = await getSlotQueueContext({ slotId, branchId, appointmentDate });

    await withTransaction(async (connection) => {
        const actorUserId = getActorUserId(req);
        await ensureQueueSession(connection, {
            branchId: queueContext.branchId,
            slotId: queueContext.slotId,
            appointmentDate: queueContext.appointmentDate,
            actorUserId,
        });

        await connection.execute(
            `UPDATE tbl_live_queue_sessions
             SET session_status = ?,
                 current_appointment_id = NULL,
                 current_token_number = NULL,
                 auto_call_next_due_at = NULL,
                 auto_call_next_reason = NULL,
                 session_ended_at = NOW(),
                 updated_by = ?
             WHERE fk_branch_id = ?
               AND fk_slot_id = ?
               AND appointment_date = ?`,
            [SESSION_STATUS.COMPLETED, actorUserId, queueContext.branchId, queueContext.slotId, queueContext.appointmentDate]
        );

        await logQueueEvent(connection, {
            branchId: queueContext.branchId,
            slotId: queueContext.slotId,
            appointmentDate: queueContext.appointmentDate,
            eventType: 'SESSION_COMPLETED',
            createdBy: actorUserId,
        });

        await recalculateLiveRuntimeProjection(connection, {
            branchId: queueContext.branchId,
            slotId: queueContext.slotId,
            appointmentDate: queueContext.appointmentDate,
            actorUserId,
            actorIp: getClientIp(req),
        });
    });

    await cancelScheduledAutoCallNext({
        branchId: queueContext.branchId,
        slotId: queueContext.slotId,
        appointmentDate: queueContext.appointmentDate,
    });

    const payload = await emitLiveQueueEvent({
        branchId: queueContext.branchId,
        slotId: queueContext.slotId,
        appointmentDate: queueContext.appointmentDate,
        eventName: 'doctor-session-completed',
        reason: 'SESSION_COMPLETED',
    });

    return res.status(200).json({
        success: true,
        message: 'Doctor session completed successfully',
        data: payload,
    });
});

const mutateQueueAppointment = async ({
    req,
    appointmentId,
    allowedCurrentStatuses = ACTIVE_QUEUE_STATUSES,
    handler,
}) => withTransaction(async (connection) => {
    const [appointment] = await connection.execute(
        `SELECT appointment_id, fk_branch_id, fk_slot_id, appointment_date, current_token_number, queue_status, status, is_active, checked_in_at, arrival_sequence, planned_start_at
         FROM tbl_appointments
         WHERE appointment_id = ?
         LIMIT 1
         FOR UPDATE`,
        [appointmentId]
    );

    if (!appointment.length) {
        throw new AppError('Appointment not found', 404);
    }

    const current = appointment[0];

    if (Number(current.is_active) !== 1 || current.status === 'Cancelled') {
        throw new AppError('Only active non-cancelled appointments can be updated in live queue', 409);
    }

    if (!allowedCurrentStatuses.includes(current.queue_status)) {
        throw new AppError(`Appointment cannot be updated from queue_status ${current.queue_status}`, 409);
    }

    return handler(connection, current);
});

const checkInAppointment = asyncHandler(async (req, res) => {
    const appointmentId = toPositiveInt(req.params.appointment_id);

    if (!appointmentId) {
        throw new AppError('Valid appointment_id is required', 400);
    }

    const result = await mutateQueueAppointment({
        req,
        appointmentId,
        allowedCurrentStatuses: [QUEUE_STATUS.BOOKED, QUEUE_STATUS.WAITING],
        handler: async (connection, current) => {
            const actorUserId = getActorUserId(req);
            const actorIp = getClientIp(req);
            const nextArrivalSequence = current.checked_in_at
                ? null
                : await getNextArrivalSequence(connection, {
                    branchId: Number(current.fk_branch_id),
                    slotId: Number(current.fk_slot_id),
                    appointmentDate: current.appointment_date,
                });
            const protectedVisibleWindowAppointmentIds = !current.checked_in_at
                ? extractProtectedVisibleWindowAppointmentIds(await getLiveQueueSnapshot({
                    branchId: Number(current.fk_branch_id),
                    slotId: Number(current.fk_slot_id),
                    appointmentDate: current.appointment_date,
                    connection,
                }))
                : [];

            await connection.execute(
                `UPDATE tbl_appointments
                 SET queue_status = ?,
                     checked_in_at = COALESCE(checked_in_at, NOW()),
                     arrival_sequence = COALESCE(arrival_sequence, ?),
                     last_queue_event_at = NOW(),
                     updated_by = ?,
                     updated_ip = ?
                 WHERE appointment_id = ?`,
                [QUEUE_STATUS.CHECKED_IN, nextArrivalSequence, actorUserId, actorIp, appointmentId]
            );

            await logQueueEvent(connection, {
                appointmentId,
                branchId: Number(current.fk_branch_id),
                slotId: Number(current.fk_slot_id),
                appointmentDate: current.appointment_date,
                tokenNumber: Number(current.current_token_number),
                eventType: 'CHECKED_IN',
                oldQueueStatus: current.queue_status,
                newQueueStatus: QUEUE_STATUS.CHECKED_IN,
                createdBy: actorUserId,
                meta: {
                    protected_visible_window_appointment_ids: protectedVisibleWindowAppointmentIds,
                    protected_visible_window_size: protectedVisibleWindowAppointmentIds.length,
                    protected_window_reason: 'VISIBLE_QUEUE_STABILITY_ON_CHECK_IN',
                },
            });

            await recalculateLiveRuntimeProjection(connection, {
                branchId: Number(current.fk_branch_id),
                slotId: Number(current.fk_slot_id),
                appointmentDate: current.appointment_date,
                actorUserId,
                actorIp,
            });

            return {
                branchId: Number(current.fk_branch_id),
                slotId: Number(current.fk_slot_id),
                appointmentDate: current.appointment_date,
            };
        },
    });

    const payload = await emitLiveQueueEvent({
        branchId: result.branchId,
        slotId: result.slotId,
        appointmentDate: result.appointmentDate,
        eventName: 'queue-updated',
        reason: 'CHECKED_IN',
        appointmentId,
    });

    return res.status(200).json({
        success: true,
        message: 'Appointment checked in successfully',
        data: payload,
    });
});

const callToken = asyncHandler(async (req, res) => {
    const appointmentId = toPositiveInt(req.params.appointment_id);

    if (!appointmentId) {
        throw new AppError('Valid appointment_id is required', 400);
    }

    const result = await mutateQueueAppointment({
        req,
        appointmentId,
        allowedCurrentStatuses: [QUEUE_STATUS.BOOKED, QUEUE_STATUS.CHECKED_IN, QUEUE_STATUS.WAITING],
        handler: async (connection, current) => {
            const actorUserId = getActorUserId(req);
            await ensureQueueSession(connection, {
                branchId: Number(current.fk_branch_id),
                slotId: Number(current.fk_slot_id),
                appointmentDate: current.appointment_date,
                actorUserId,
            });

            await assertQueueSessionCanAdvance(connection, {
                branchId: Number(current.fk_branch_id),
                slotId: Number(current.fk_slot_id),
                appointmentDate: current.appointment_date,
            });

            await connection.execute(
                `UPDATE tbl_live_queue_sessions
                SET session_status = CASE
                        WHEN session_status IN ('NOT_STARTED', 'COMPLETED') THEN 'RUNNING'
                        ELSE session_status
                    END,
                    session_started_at = COALESCE(session_started_at, NOW()),
                    session_ended_at = NULL,
                    current_appointment_id = ?,
                    current_token_number = ?,
                    auto_call_next_due_at = NULL,
                    auto_call_next_reason = NULL,
                    updated_by = ?
                 WHERE fk_branch_id = ?
                   AND fk_slot_id = ?
                   AND appointment_date = ?`,
                [
                    appointmentId,
                    current.current_token_number,
                    actorUserId,
                    current.fk_branch_id,
                    current.fk_slot_id,
                    current.appointment_date,
                ]
            );

            await connection.execute(
                `UPDATE tbl_appointments
                 SET queue_status = ?,
                     actual_called_at = NOW(),
                     last_queue_event_at = NOW(),
                     updated_by = ?,
                     updated_ip = ?
                 WHERE appointment_id = ?`,
                [QUEUE_STATUS.WAITING, actorUserId, getClientIp(req), appointmentId]
            );

            await logQueueEvent(connection, {
                appointmentId,
                branchId: Number(current.fk_branch_id),
                slotId: Number(current.fk_slot_id),
                appointmentDate: current.appointment_date,
                tokenNumber: Number(current.current_token_number),
                eventType: 'TOKEN_CALLED',
                oldQueueStatus: current.queue_status,
                newQueueStatus: QUEUE_STATUS.WAITING,
                createdBy: actorUserId,
            });

            await recalculateLiveRuntimeProjection(connection, {
                branchId: Number(current.fk_branch_id),
                slotId: Number(current.fk_slot_id),
                appointmentDate: current.appointment_date,
                actorUserId,
                actorIp: getClientIp(req),
            });

            return {
                branchId: Number(current.fk_branch_id),
                slotId: Number(current.fk_slot_id),
                appointmentDate: current.appointment_date,
                tokenNumber: Number(current.current_token_number),
            };
        },
    });

    await cancelScheduledAutoCallNext({
        branchId: result.branchId,
        slotId: result.slotId,
        appointmentDate: result.appointmentDate,
    });

    const payload = await emitLiveQueueEvent({
        branchId: result.branchId,
        slotId: result.slotId,
        appointmentDate: result.appointmentDate,
        eventName: 'token-called',
        reason: 'TOKEN_CALLED',
        appointmentId,
        extra: {
            token_number: result.tokenNumber,
        },
    });

    return res.status(200).json({
        success: true,
        message: 'Token called successfully',
        data: payload,
    });
});

const callNextReadyToken = asyncHandler(async (req, res) => {
    const slotId = toPositiveInt(req.params.slot_id);
    const branchId = toPositiveInt(req.body?.branch_id || req.query?.branch_id);
    const appointmentDate = String(req.body?.appointment_date || req.query?.appointment_date || '').trim();

    if (!slotId || !branchId || !isValidDateString(appointmentDate)) {
        throw new AppError('slot_id, branch_id and appointment_date are required', 400);
    }

    const queueContext = await getSlotQueueContext({ slotId, branchId, appointmentDate });

    await cancelScheduledAutoCallNext({
        branchId: queueContext.branchId,
        slotId: queueContext.slotId,
        appointmentDate: queueContext.appointmentDate,
    });

    const result = await withTransaction(async (connection) => autoSelectAndCallNextReady(connection, {
        branchId: queueContext.branchId,
        slotId: queueContext.slotId,
        appointmentDate: queueContext.appointmentDate,
        actorUserId: getActorUserId(req),
        actorIp: getClientIp(req),
        eventType: 'TOKEN_CALLED_AUTO_NEXT',
        selectionBasis: 'SCHEDULED_PRESENT_THEN_LONGEST_WAITING_PRESENT_HOLD',
    }));

    const payload = await emitLiveQueueEvent({
        branchId: result.branchId,
        slotId: result.slotId,
        appointmentDate: result.appointmentDate,
        eventName: 'token-called',
        reason: 'TOKEN_CALLED_AUTO_NEXT',
        appointmentId: result.appointmentId,
        extra: {
            token_number: result.tokenNumber,
            auto_selected: true,
            runtime_assignment_mode: result.assignmentMode,
            scheduled_due_token_number: result.scheduledDueTokenNumber,
        },
    });

    return res.status(200).json({
        success: true,
        message: 'Next ready token called successfully',
        data: payload,
    });
});

const startConsultation = asyncHandler(async (req, res) => {
    const appointmentId = toPositiveInt(req.params.appointment_id);

    if (!appointmentId) {
        throw new AppError('Valid appointment_id is required', 400);
    }

    const result = await mutateQueueAppointment({
        req,
        appointmentId,
        allowedCurrentStatuses: [QUEUE_STATUS.BOOKED, QUEUE_STATUS.CHECKED_IN, QUEUE_STATUS.WAITING, QUEUE_STATUS.IN_PROGRESS],
        handler: async (connection, current) => {
            const actorUserId = getActorUserId(req);
            const actorIp = getClientIp(req);

            if (current.queue_status !== QUEUE_STATUS.IN_PROGRESS) {
                const [runningAppointments] = await connection.execute(
                    `SELECT appointment_id, current_token_number
                     FROM tbl_appointments
                     WHERE fk_branch_id = ?
                       AND fk_slot_id = ?
                       AND appointment_date = ?
                       AND is_active = 1
                       AND queue_status = ?
                       AND appointment_id <> ?
                     LIMIT 1
                     FOR UPDATE`,
                    [
                        current.fk_branch_id,
                        current.fk_slot_id,
                        current.appointment_date,
                        QUEUE_STATUS.IN_PROGRESS,
                        appointmentId,
                    ]
                );

                if (runningAppointments.length > 0) {
                    return {
                        branchId: Number(current.fk_branch_id),
                        slotId: Number(current.fk_slot_id),
                        appointmentDate: current.appointment_date,
                        tokenNumber: Number(current.current_token_number),
                        directConsultation: true,
                    };
                }
            }

            if (current.queue_status === QUEUE_STATUS.IN_PROGRESS) {
                await ensureQueueSession(connection, {
                    branchId: Number(current.fk_branch_id),
                    slotId: Number(current.fk_slot_id),
                    appointmentDate: current.appointment_date,
                    actorUserId,
                });

                await connection.execute(
                    `UPDATE tbl_live_queue_sessions
                     SET session_status = CASE
                            WHEN session_status = 'NOT_STARTED' THEN 'RUNNING'
                            ELSE session_status
                        END,
                        session_started_at = COALESCE(session_started_at, NOW()),
                        current_appointment_id = ?,
                        current_token_number = ?,
                        auto_call_next_due_at = NULL,
                        auto_call_next_reason = NULL,
                        updated_by = ?
                     WHERE fk_branch_id = ?
                       AND fk_slot_id = ?
                       AND appointment_date = ?`,
                    [
                        appointmentId,
                        current.current_token_number,
                        actorUserId,
                        current.fk_branch_id,
                        current.fk_slot_id,
                        current.appointment_date,
                    ]
                );

                await recalculateLiveRuntimeProjection(connection, {
                    branchId: Number(current.fk_branch_id),
                    slotId: Number(current.fk_slot_id),
                    appointmentDate: current.appointment_date,
                    actorUserId,
                    actorIp,
                });

                return {
                    branchId: Number(current.fk_branch_id),
                    slotId: Number(current.fk_slot_id),
                    appointmentDate: current.appointment_date,
                    tokenNumber: Number(current.current_token_number),
                    alreadyInProgress: true,
                };
            }

            const nextArrivalSequence = current.checked_in_at
                ? null
                : await getNextArrivalSequence(connection, {
                    branchId: Number(current.fk_branch_id),
                    slotId: Number(current.fk_slot_id),
                    appointmentDate: current.appointment_date,
                });

            await ensureQueueSession(connection, {
                branchId: Number(current.fk_branch_id),
                slotId: Number(current.fk_slot_id),
                appointmentDate: current.appointment_date,
                actorUserId,
            });

            await assertQueueSessionCanAdvance(connection, {
                branchId: Number(current.fk_branch_id),
                slotId: Number(current.fk_slot_id),
                appointmentDate: current.appointment_date,
            });

            await connection.execute(
                `UPDATE tbl_appointments
                 SET queue_status = ?,
                     checked_in_at = COALESCE(checked_in_at, NOW()),
                     arrival_sequence = COALESCE(arrival_sequence, ?),
                     actual_called_at = COALESCE(actual_called_at, NOW()),
                     actual_started_at = NOW(),
                     last_queue_event_at = NOW(),
                     updated_by = ?,
                     updated_ip = ?
                 WHERE appointment_id = ?`,
                [QUEUE_STATUS.IN_PROGRESS, nextArrivalSequence, actorUserId, actorIp, appointmentId]
            );

            await connection.execute(
                `UPDATE tbl_live_queue_sessions
                SET session_status = CASE
                        WHEN session_status = 'NOT_STARTED' THEN 'RUNNING'
                        ELSE session_status
                    END,
                    session_started_at = COALESCE(session_started_at, NOW()),
                    current_appointment_id = ?,
                    current_token_number = ?,
                    auto_call_next_due_at = NULL,
                    auto_call_next_reason = NULL,
                    updated_by = ?
                 WHERE fk_branch_id = ?
                   AND fk_slot_id = ?
                   AND appointment_date = ?`,
                [
                    appointmentId,
                    current.current_token_number,
                    actorUserId,
                    current.fk_branch_id,
                    current.fk_slot_id,
                    current.appointment_date,
                ]
            );

            await logQueueEvent(connection, {
                appointmentId,
                branchId: Number(current.fk_branch_id),
                slotId: Number(current.fk_slot_id),
                appointmentDate: current.appointment_date,
                tokenNumber: Number(current.current_token_number),
                eventType: 'CONSULTATION_STARTED',
                oldQueueStatus: current.queue_status,
                newQueueStatus: QUEUE_STATUS.IN_PROGRESS,
                createdBy: actorUserId,
            });

            await recalculateLiveRuntimeProjection(connection, {
                branchId: Number(current.fk_branch_id),
                slotId: Number(current.fk_slot_id),
                appointmentDate: current.appointment_date,
                actorUserId,
                actorIp,
            });

            return {
                branchId: Number(current.fk_branch_id),
                slotId: Number(current.fk_slot_id),
                appointmentDate: current.appointment_date,
                tokenNumber: Number(current.current_token_number),
            };
        },
    });

    if (result.directConsultation) {
        return res.status(200).json({
            success: true,
            message: 'Direct consultation opened without changing live queue',
            data: {
                appointment_id: appointmentId,
                branch_id: result.branchId,
                slot_id: result.slotId,
                appointment_date: result.appointmentDate,
                token_number: result.tokenNumber,
                direct_consultation: true,
            },
        });
    }

    await cancelScheduledAutoCallNext({
        branchId: result.branchId,
        slotId: result.slotId,
        appointmentDate: result.appointmentDate,
    });

    const payload = await emitLiveQueueEvent({
        branchId: result.branchId,
        slotId: result.slotId,
        appointmentDate: result.appointmentDate,
        eventName: 'consultation-started',
        reason: result.alreadyInProgress ? 'CONSULTATION_ALREADY_IN_PROGRESS' : 'CONSULTATION_STARTED',
        appointmentId,
        extra: {
            token_number: result.tokenNumber,
            already_in_progress: Boolean(result.alreadyInProgress),
        },
    });

    return res.status(200).json({
        success: true,
        message: result.alreadyInProgress
            ? 'Consultation already in progress'
            : 'Consultation started in live queue successfully',
        data: payload,
    });
});

const completeConsultation = asyncHandler(async (req, res) => {
    const appointmentId = toPositiveInt(req.params.appointment_id);

    if (!appointmentId) {
        throw new AppError('Valid appointment_id is required', 400);
    }

    const result = await mutateQueueAppointment({
        req,
        appointmentId,
        allowedCurrentStatuses: [QUEUE_STATUS.IN_PROGRESS, QUEUE_STATUS.WAITING, QUEUE_STATUS.CHECKED_IN, QUEUE_STATUS.BOOKED],
        handler: async (connection, current) => {
            const actorUserId = getActorUserId(req);
            const actorIp = getClientIp(req);
            const nextArrivalSequence = current.checked_in_at
                ? null
                : await getNextArrivalSequence(connection, {
                    branchId: Number(current.fk_branch_id),
                    slotId: Number(current.fk_slot_id),
                    appointmentDate: current.appointment_date,
                });

            await connection.execute(
                `UPDATE tbl_appointments
                 SET queue_status = ?,
                     checked_in_at = COALESCE(checked_in_at, NOW()),
                     arrival_sequence = COALESCE(arrival_sequence, ?),
                     actual_started_at = COALESCE(actual_started_at, NOW()),
                     actual_completed_at = NOW(),
                     last_queue_event_at = NOW(),
                     updated_by = ?,
                     updated_ip = ?
                 WHERE appointment_id = ?`,
                [QUEUE_STATUS.COMPLETED, nextArrivalSequence, actorUserId, actorIp, appointmentId]
            );

            await connection.execute(
                `UPDATE tbl_live_queue_sessions
                 SET current_appointment_id = NULL,
                     current_token_number = NULL,
                     auto_call_next_due_at = NULL,
                     auto_call_next_reason = NULL,
                     updated_by = ?
                 WHERE fk_branch_id = ?
                   AND fk_slot_id = ?
                   AND appointment_date = ?`,
                [actorUserId, current.fk_branch_id, current.fk_slot_id, current.appointment_date]
            );

            const [remainingRows] = await connection.execute(
                `SELECT appointment_id
                 FROM tbl_appointments
                 WHERE fk_branch_id = ?
                   AND fk_slot_id = ?
                   AND appointment_date = ?
                   AND is_active = 1
                   AND queue_status IN (${ACTIVE_QUEUE_STATUSES.map(() => '?').join(', ')})
                 LIMIT 1`,
                [current.fk_branch_id, current.fk_slot_id, current.appointment_date, ...ACTIVE_QUEUE_STATUSES]
            );

            if (remainingRows.length === 0) {
                await connection.execute(
                    `UPDATE tbl_live_queue_sessions
                     SET session_status = ?,
                         session_ended_at = NOW(),
                         updated_by = ?
                     WHERE fk_branch_id = ?
                       AND fk_slot_id = ?
                       AND appointment_date = ?`,
                    [SESSION_STATUS.COMPLETED, actorUserId, current.fk_branch_id, current.fk_slot_id, current.appointment_date]
                );
            }

            await logQueueEvent(connection, {
                appointmentId,
                branchId: Number(current.fk_branch_id),
                slotId: Number(current.fk_slot_id),
                appointmentDate: current.appointment_date,
                tokenNumber: Number(current.current_token_number),
                eventType: 'CONSULTATION_COMPLETED',
                oldQueueStatus: current.queue_status,
                newQueueStatus: QUEUE_STATUS.COMPLETED,
                createdBy: actorUserId,
            });

            return {
                branchId: Number(current.fk_branch_id),
                slotId: Number(current.fk_slot_id),
                appointmentDate: current.appointment_date,
                tokenNumber: Number(current.current_token_number),
                hasRemainingQueue: remainingRows.length > 0,
            };
        },
    });

    let autoCallNextDueAt = null;

    if (result.hasRemainingQueue) {
        autoCallNextDueAt = await scheduleAutoCallNext({
            branchId: result.branchId,
            slotId: result.slotId,
            appointmentDate: result.appointmentDate,
            actorUserId: getActorUserId(req),
            delayMs: DEFAULT_AUTO_CALL_DELAY_MS,
            reason: 'AUTO_CALL_NEXT_AFTER_CONSULT_COMPLETE',
        });
    }

    const payload = await emitLiveQueueEvent({
        branchId: result.branchId,
        slotId: result.slotId,
        appointmentDate: result.appointmentDate,
        eventName: 'consultation-completed',
        reason: 'CONSULTATION_COMPLETED',
        appointmentId,
        extra: {
            token_number: result.tokenNumber,
            auto_call_next_due_at: autoCallNextDueAt ? formatDateTimeForSql(autoCallNextDueAt) : null,
        },
    });

    return res.status(200).json({
        success: true,
        message: 'Consultation completed in live queue successfully',
        data: payload,
    });
});

const skipToken = asyncHandler(async (req, res) => {
    const appointmentId = toPositiveInt(req.params.appointment_id);
    const reason = req.body?.reason ? String(req.body.reason).trim() : 'TOKEN_SKIPPED';

    if (!appointmentId) {
        throw new AppError('Valid appointment_id is required', 400);
    }

    const result = await mutateQueueAppointment({
        req,
        appointmentId,
        allowedCurrentStatuses: [QUEUE_STATUS.BOOKED, QUEUE_STATUS.CHECKED_IN, QUEUE_STATUS.WAITING],
        handler: async (connection, current) => {
            const actorUserId = getActorUserId(req);
            const [queueRows] = await connection.execute(
                `SELECT appointment_id, current_token_number
                 FROM tbl_appointments
                 WHERE fk_branch_id = ?
                   AND fk_slot_id = ?
                   AND appointment_date = ?
                   AND is_active = 1
                   AND status <> 'Cancelled'
                   AND appointment_id != ?
                   AND current_token_number > ?
                 ORDER BY current_token_number ASC
                 FOR UPDATE`,
                [
                    current.fk_branch_id,
                    current.fk_slot_id,
                    current.appointment_date,
                    appointmentId,
                    current.current_token_number,
                ]
            );

            for (const row of queueRows) {
                await connection.execute(
                    `UPDATE tbl_appointments
                     SET current_token_number = current_token_number - 1,
                         updated_by = ?,
                         updated_ip = ?
                     WHERE appointment_id = ?`,
                    [actorUserId, getClientIp(req), row.appointment_id]
                );
            }

            const newTokenNumber = queueRows.length + Number(current.current_token_number);

            await connection.execute(
                `UPDATE tbl_appointments
                 SET current_token_number = ?,
                     queue_status = ?,
                     actual_called_at = NULL,
                     checked_in_at = NULL,
                     arrival_sequence = NULL,
                     is_shifted = 1,
                     shift_reason = ?,
                     last_queue_event_at = NOW(),
                     updated_by = ?,
                     updated_ip = ?
                 WHERE appointment_id = ?`,
                [newTokenNumber, QUEUE_STATUS.WAITING, reason, actorUserId, getClientIp(req), appointmentId]
            );

            await recalculateQueuePlan(connection, {
                branchId: Number(current.fk_branch_id),
                slotId: Number(current.fk_slot_id),
                appointmentDate: current.appointment_date,
                actorUserId,
                actorIp: getClientIp(req),
            });

            await connection.execute(
                `UPDATE tbl_live_queue_sessions
                 SET current_appointment_id = CASE WHEN current_appointment_id = ? THEN NULL ELSE current_appointment_id END,
                     current_token_number = CASE WHEN current_appointment_id = ? THEN NULL ELSE current_token_number END,
                     updated_by = ?
                 WHERE fk_branch_id = ?
                   AND fk_slot_id = ?
                   AND appointment_date = ?`,
                [
                    appointmentId,
                    appointmentId,
                    actorUserId,
                    current.fk_branch_id,
                    current.fk_slot_id,
                    current.appointment_date,
                ]
            );

            await recalculateLiveRuntimeProjection(connection, {
                branchId: Number(current.fk_branch_id),
                slotId: Number(current.fk_slot_id),
                appointmentDate: current.appointment_date,
                actorUserId,
                actorIp: getClientIp(req),
            });

            await logQueueEvent(connection, {
                appointmentId,
                branchId: Number(current.fk_branch_id),
                slotId: Number(current.fk_slot_id),
                appointmentDate: current.appointment_date,
                tokenNumber: newTokenNumber,
                eventType: 'TOKEN_SKIPPED',
                oldQueueStatus: current.queue_status,
                newQueueStatus: QUEUE_STATUS.WAITING,
                createdBy: actorUserId,
                meta: { reason },
            });

            return {
                branchId: Number(current.fk_branch_id),
                slotId: Number(current.fk_slot_id),
                appointmentDate: current.appointment_date,
                tokenNumber: newTokenNumber,
            };
        },
    });

    const payload = await emitLiveQueueEvent({
        branchId: result.branchId,
        slotId: result.slotId,
        appointmentDate: result.appointmentDate,
        eventName: 'token-shifted',
        reason: 'TOKEN_SKIPPED',
        appointmentId,
        extra: {
            token_number: result.tokenNumber,
        },
    });

    return res.status(200).json({
        success: true,
        message: 'Token skipped and moved to queue end successfully',
        data: payload,
    });
});

const reassignToken = asyncHandler(async (req, res) => {
    const appointmentId = toPositiveInt(req.params.appointment_id);
    const requestedTokenNumber = toPositiveInt(req.body?.token_number);
    const reason = req.body?.reason ? String(req.body.reason).trim() : 'TOKEN_REASSIGNED';

    if (!appointmentId || !requestedTokenNumber) {
        throw new AppError('appointment_id and token_number are required', 400);
    }

    const result = await mutateQueueAppointment({
        req,
        appointmentId,
        allowedCurrentStatuses: [QUEUE_STATUS.BOOKED, QUEUE_STATUS.CHECKED_IN, QUEUE_STATUS.WAITING],
        handler: async (connection, current) => {
            const actorUserId = getActorUserId(req);
            const [queueRows] = await connection.execute(
                `SELECT appointment_id, current_token_number
                 FROM tbl_appointments
                 WHERE fk_branch_id = ?
                   AND fk_slot_id = ?
                   AND appointment_date = ?
                   AND is_active = 1
                   AND status <> 'Cancelled'
                 ORDER BY current_token_number ASC
                 FOR UPDATE`,
                [current.fk_branch_id, current.fk_slot_id, current.appointment_date]
            );

            const maxTokenNumber = queueRows.length;
            if (requestedTokenNumber > maxTokenNumber) {
                throw new AppError(`token_number must be between 1 and ${maxTokenNumber}`, 400);
            }

            const oldTokenNumber = Number(current.current_token_number);
            if (oldTokenNumber === requestedTokenNumber) {
                throw new AppError('Appointment is already assigned to the requested token number', 409);
            }

            if (requestedTokenNumber < oldTokenNumber) {
                await connection.execute(
                    `UPDATE tbl_appointments
                     SET current_token_number = current_token_number + 1,
                         updated_by = ?,
                         updated_ip = ?
                     WHERE fk_branch_id = ?
                       AND fk_slot_id = ?
                       AND appointment_date = ?
                       AND appointment_id != ?
                       AND current_token_number >= ?
                       AND current_token_number < ?`,
                    [
                        actorUserId,
                        getClientIp(req),
                        current.fk_branch_id,
                        current.fk_slot_id,
                        current.appointment_date,
                        appointmentId,
                        requestedTokenNumber,
                        oldTokenNumber,
                    ]
                );
            } else {
                await connection.execute(
                    `UPDATE tbl_appointments
                     SET current_token_number = current_token_number - 1,
                         updated_by = ?,
                         updated_ip = ?
                     WHERE fk_branch_id = ?
                       AND fk_slot_id = ?
                       AND appointment_date = ?
                       AND appointment_id != ?
                       AND current_token_number > ?
                       AND current_token_number <= ?`,
                    [
                        actorUserId,
                        getClientIp(req),
                        current.fk_branch_id,
                        current.fk_slot_id,
                        current.appointment_date,
                        appointmentId,
                        oldTokenNumber,
                        requestedTokenNumber,
                    ]
                );
            }

            await connection.execute(
                `UPDATE tbl_appointments
                 SET current_token_number = ?,
                     queue_status = ?,
                     is_shifted = 1,
                     shift_reason = ?,
                     last_queue_event_at = NOW(),
                     updated_by = ?,
                     updated_ip = ?
                 WHERE appointment_id = ?`,
                [requestedTokenNumber, QUEUE_STATUS.WAITING, reason, actorUserId, getClientIp(req), appointmentId]
            );

            await recalculateQueuePlan(connection, {
                branchId: Number(current.fk_branch_id),
                slotId: Number(current.fk_slot_id),
                appointmentDate: current.appointment_date,
                actorUserId,
                actorIp: getClientIp(req),
            });

            await connection.execute(
                `UPDATE tbl_live_queue_sessions
                 SET current_appointment_id = CASE WHEN current_appointment_id = ? THEN NULL ELSE current_appointment_id END,
                     current_token_number = CASE WHEN current_appointment_id = ? THEN NULL ELSE current_token_number END,
                     updated_by = ?
                 WHERE fk_branch_id = ?
                   AND fk_slot_id = ?
                   AND appointment_date = ?`,
                [
                    appointmentId,
                    appointmentId,
                    actorUserId,
                    current.fk_branch_id,
                    current.fk_slot_id,
                    current.appointment_date,
                ]
            );

            await recalculateLiveRuntimeProjection(connection, {
                branchId: Number(current.fk_branch_id),
                slotId: Number(current.fk_slot_id),
                appointmentDate: current.appointment_date,
                actorUserId,
                actorIp: getClientIp(req),
            });

            await logQueueEvent(connection, {
                appointmentId,
                branchId: Number(current.fk_branch_id),
                slotId: Number(current.fk_slot_id),
                appointmentDate: current.appointment_date,
                tokenNumber: requestedTokenNumber,
                eventType: 'TOKEN_REASSIGNED',
                oldQueueStatus: current.queue_status,
                newQueueStatus: QUEUE_STATUS.WAITING,
                createdBy: actorUserId,
                meta: {
                    old_token_number: oldTokenNumber,
                    new_token_number: requestedTokenNumber,
                    reason,
                },
            });

            return {
                branchId: Number(current.fk_branch_id),
                slotId: Number(current.fk_slot_id),
                appointmentDate: current.appointment_date,
                tokenNumber: requestedTokenNumber,
            };
        },
    });

    const payload = await emitLiveQueueEvent({
        branchId: result.branchId,
        slotId: result.slotId,
        appointmentDate: result.appointmentDate,
        eventName: 'token-shifted',
        reason: 'TOKEN_REASSIGNED',
        appointmentId,
        extra: {
            token_number: result.tokenNumber,
        },
    });

    return res.status(200).json({
        success: true,
        message: 'Token reassigned successfully',
        data: payload,
    });
});

module.exports = {
    getLiveQueue,
    listCurrentDateTokens,
    listReplayEvents,
    startDoctorSession,
    completeDoctorSession,
    checkInAppointment,
    callToken,
    callNextReadyToken,
    startConsultation,
    completeConsultation,
    skipToken,
    reassignToken,
};
