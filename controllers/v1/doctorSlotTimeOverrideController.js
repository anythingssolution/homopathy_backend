const { query, withTransaction } = require('../../config/db');
const AppError = require('../../utils/AppError');
const asyncHandler = require('../../utils/asyncHandler');
const {
    calculateShiftedTiming,
    resolveEffectiveSlotTiming,
    shiftActiveExtensionTokenTimes,
} = require('../../services/slotTimeOverrideService');
const {
    emitLiveQueueEvent,
    recalculateQueuePlan,
} = require('../../services/liveQueueService');

const toPositiveInt = (value) => {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};
const isValidDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
const getToday = () => {
    const date = new Date();
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
};
const getClientIp = (req) => {
    const forwarded = req.headers['x-forwarded-for'];
    return forwarded ? forwarded.split(',')[0].trim() : (req.ip || req.socket?.remoteAddress || null);
};

const parseContext = (req) => {
    const branchId = toPositiveInt(req.selectedBranchId || req.query.branch_id || req.body.branch_id);
    const slotId = toPositiveInt(req.query.slot_id || req.body.slot_id);
    const appointmentDate = String(req.query.appointment_date || req.body.appointment_date || '').trim();
    if (!branchId || !slotId || !isValidDate(appointmentDate)) {
        throw new AppError('branch_id, slot_id and appointment_date (YYYY-MM-DD) are required', 400);
    }
    if (appointmentDate < getToday()) {
        throw new AppError('Past date slot timing cannot be changed', 400);
    }
    return { branchId, slotId, appointmentDate };
};

const assertQueueCanShift = async (connection, context) => {
    const [sessionRows] = await connection.execute(
        `SELECT session_status
         FROM tbl_live_queue_sessions
         WHERE fk_branch_id = ? AND fk_slot_id = ? AND appointment_date = ?
         LIMIT 1 FOR UPDATE`,
        [context.branchId, context.slotId, context.appointmentDate]
    );
    if (sessionRows[0] && sessionRows[0].session_status !== 'NOT_STARTED') {
        throw new AppError('Slot timing cannot be changed after the queue session has started', 409);
    }

    const [startedRows] = await connection.execute(
        `SELECT appointment_id
         FROM tbl_appointments
         WHERE fk_branch_id = ? AND fk_slot_id = ? AND appointment_date = ?
           AND is_active = 1
           AND queue_status IN ('CHECKED_IN', 'WAITING', 'IN_PROGRESS', 'COMPLETED')
         LIMIT 1 FOR UPDATE`,
        [context.branchId, context.slotId, context.appointmentDate]
    );
    if (startedRows.length > 0) {
        throw new AppError('Slot timing cannot be changed after patient check-in or consultation activity', 409);
    }
};

const listSlotTimings = asyncHandler(async (req, res) => {
    const branchId = toPositiveInt(req.selectedBranchId || req.query.branch_id);
    const appointmentDate = String(req.query.appointment_date || '').trim();
    if (!branchId || !isValidDate(appointmentDate)) {
        throw new AppError('branch_id and appointment_date (YYYY-MM-DD) are required', 400);
    }

    const rows = await query(
        `SELECT s.id AS slot_id, s.slot_name,
                s.start_time AS default_start_time, s.end_time AS default_end_time,
                COALESCE(o.override_start_time, s.start_time) AS effective_start_time,
                COALESCE(o.override_end_time, s.end_time) AS effective_end_time,
                o.id AS override_id, o.reason,
                CASE WHEN o.id IS NULL THEN 0 ELSE 1 END AS has_override
         FROM master_slots s
         LEFT JOIN tbl_doctor_slot_time_overrides o
           ON o.fk_branch_id = s.fk_branch_id
          AND o.fk_slot_id = s.id
          AND o.appointment_date = ?
          AND o.status = 'ACTIVE'
         WHERE s.fk_branch_id = ? AND s.is_active = 1
         ORDER BY s.start_time ASC`,
        [appointmentDate, branchId]
    );

    return res.status(200).json({
        success: true,
        message: 'Date-wise slot timings fetched successfully',
        data: rows.map((row) => ({ ...row, has_override: Boolean(Number(row.has_override)) })),
    });
});

const saveSlotTiming = asyncHandler(async (req, res) => {
    const context = parseContext(req);
    const overrideStartInput = String(req.body.override_start_time || '').trim();
    const reason = String(req.body.reason || '').trim().slice(0, 500) || null;
    let result;

    result = await withTransaction(async (connection) => {
        await assertQueueCanShift(connection, context);
        const current = await resolveEffectiveSlotTiming({ executor: connection, ...context, lock: true });
        const shifted = calculateShiftedTiming({
            defaultStartTime: current.defaultStartTime,
            defaultEndTime: current.defaultEndTime,
            overrideStartTime: overrideStartInput,
        });
        const previousShift = current.hasOverride
            ? calculateShiftedTiming({
                defaultStartTime: current.defaultStartTime,
                defaultEndTime: current.defaultEndTime,
                overrideStartTime: current.effectiveStartTime,
            }).shiftSeconds
            : 0;
        const deltaSeconds = shifted.shiftSeconds - previousShift;

        const [upsert] = await connection.execute(
            `INSERT INTO tbl_doctor_slot_time_overrides
             (fk_branch_id, fk_slot_id, appointment_date, default_start_time, default_end_time,
              override_start_time, override_end_time, shift_seconds, reason, status,
              created_by, updated_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?)
             ON DUPLICATE KEY UPDATE
               default_start_time = VALUES(default_start_time),
               default_end_time = VALUES(default_end_time),
               override_start_time = VALUES(override_start_time),
               override_end_time = VALUES(override_end_time),
               shift_seconds = VALUES(shift_seconds),
               reason = VALUES(reason),
               status = 'ACTIVE',
               updated_by = VALUES(updated_by),
               cancelled_by = NULL,
               cancelled_at = NULL`,
            [
                context.branchId, context.slotId, context.appointmentDate,
                current.defaultStartTime, current.defaultEndTime,
                shifted.overrideStartTime, shifted.overrideEndTime, shifted.shiftSeconds,
                reason, req.user.id, req.user.id,
            ]
        );
        const overrideId = current.overrideId || upsert.insertId;
        const affectedExtensionTokens = await shiftActiveExtensionTokenTimes({
            connection,
            ...context,
            deltaSeconds,
        });
        const [appointmentRows] = await connection.execute(
            `SELECT COUNT(*) AS total
             FROM tbl_appointments
             WHERE fk_branch_id = ? AND fk_slot_id = ? AND appointment_date = ?
               AND is_active = 1`,
            [context.branchId, context.slotId, context.appointmentDate]
        );

        await recalculateQueuePlan(connection, {
            branchId: context.branchId,
            slotId: context.slotId,
            appointmentDate: context.appointmentDate,
            actorUserId: req.user.id,
        });
        await connection.execute(
            `INSERT INTO tbl_doctor_slot_time_override_audit_logs
             (fk_override_id, fk_branch_id, fk_slot_id, appointment_date, action,
              old_data_json, new_data_json, affected_appointments,
              affected_extension_tokens, performed_by, ip_address)
             VALUES (?, ?, ?, ?, 'UPSERT', ?, ?, ?, ?, ?, ?)`,
            [
                overrideId, context.branchId, context.slotId, context.appointmentDate,
                JSON.stringify(current),
                JSON.stringify(shifted),
                Number(appointmentRows[0].total),
                affectedExtensionTokens,
                req.user.id,
                getClientIp(req),
            ]
        );

        return {
            ...context,
            ...shifted,
            affectedAppointments: Number(appointmentRows[0].total),
            affectedExtensionTokens,
        };
    });

    await emitLiveQueueEvent({
        branchId: context.branchId,
        slotId: context.slotId,
        appointmentDate: context.appointmentDate,
        eventName: 'slot-timing-updated',
        reason: 'DOCTOR_DATE_SLOT_TIME_OVERRIDE',
    });

    return res.status(200).json({
        success: true,
        message: 'Date-wise slot timing updated successfully',
        data: result,
    });
});

const resetSlotTiming = asyncHandler(async (req, res) => {
    const context = parseContext(req);
    const result = await withTransaction(async (connection) => {
        await assertQueueCanShift(connection, context);
        const current = await resolveEffectiveSlotTiming({ executor: connection, ...context, lock: true });
        if (!current.hasOverride) {
            return { ...context, changed: false };
        }

        const currentShift = calculateShiftedTiming({
            defaultStartTime: current.defaultStartTime,
            defaultEndTime: current.defaultEndTime,
            overrideStartTime: current.effectiveStartTime,
        }).shiftSeconds;
        const affectedExtensionTokens = await shiftActiveExtensionTokenTimes({
            connection,
            ...context,
            deltaSeconds: -currentShift,
        });
        await connection.execute(
            `UPDATE tbl_doctor_slot_time_overrides
             SET status = 'CANCELLED', cancelled_by = ?, cancelled_at = NOW(), updated_by = ?
             WHERE id = ?`,
            [req.user.id, req.user.id, current.overrideId]
        );
        const [appointmentRows] = await connection.execute(
            `SELECT COUNT(*) AS total FROM tbl_appointments
             WHERE fk_branch_id = ? AND fk_slot_id = ? AND appointment_date = ? AND is_active = 1`,
            [context.branchId, context.slotId, context.appointmentDate]
        );
        await recalculateQueuePlan(connection, {
            branchId: context.branchId,
            slotId: context.slotId,
            appointmentDate: context.appointmentDate,
            actorUserId: req.user.id,
        });
        await connection.execute(
            `INSERT INTO tbl_doctor_slot_time_override_audit_logs
             (fk_override_id, fk_branch_id, fk_slot_id, appointment_date, action,
              old_data_json, new_data_json, affected_appointments,
              affected_extension_tokens, performed_by, ip_address)
             VALUES (?, ?, ?, ?, 'RESET', ?, ?, ?, ?, ?, ?)`,
            [
                current.overrideId, context.branchId, context.slotId, context.appointmentDate,
                JSON.stringify(current),
                JSON.stringify({
                    effective_start_time: current.defaultStartTime,
                    effective_end_time: current.defaultEndTime,
                }),
                Number(appointmentRows[0].total),
                affectedExtensionTokens,
                req.user.id,
                getClientIp(req),
            ]
        );
        return { ...context, changed: true };
    });

    if (result.changed) {
        await emitLiveQueueEvent({
            branchId: context.branchId,
            slotId: context.slotId,
            appointmentDate: context.appointmentDate,
            eventName: 'slot-timing-updated',
            reason: 'DOCTOR_DATE_SLOT_TIME_RESET',
        });
    }

    return res.status(200).json({
        success: true,
        message: result.changed ? 'Slot timing reset to default successfully' : 'Slot is already using default timing',
        data: result,
    });
});

module.exports = {
    listSlotTimings,
    saveSlotTiming,
    resetSlotTiming,
};
