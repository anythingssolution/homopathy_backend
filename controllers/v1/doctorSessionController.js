const AppError = require('../../utils/AppError');
const asyncHandler = require('../../utils/asyncHandler');
const {
    getClientMetadata,
    getDoctorSessionStatus,
    getDoctorSessionLogs,
    resolveDoctorSessionTargetDoctorId,
    startDoctorSession,
    takeDoctorBreak,
    resumeDoctorBreak,
    pauseDoctorSession,
} = require('../../services/doctorSessionService');
const {
    emitLiveQueueEvent,
    emitDoctorSessionUpdateToLiveQueue,
    listTodayLiveQueueSessionsForBroadcast,
} = require('../../services/liveQueueService');

const toPositiveInt = (value) => {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) {
        return null;
    }

    return parsed;
};

const isValidDateString = (value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value || '').trim());

const buildPublicDoctorStatus = (payload) => ({
    is_doctor_available: payload.is_doctor_available,
    is_on_break: payload.is_on_break,
    has_open_session: payload.has_open_session,
    status: payload.status,
    label: payload.label,
    time: payload.time,
    started_at: payload.started_at,
    break_started_at: payload.break_started_at,
    ended_at: payload.ended_at,
    doctor_name: payload.doctor_name,
    branch_name: payload.branch_name,
    slot_id: payload.slot_id,
});

const buildSessionStatusResponse = (payload, meta = {}) => ({
    is_doctor_available: payload?.is_doctor_available ?? false,
    is_on_break: payload?.is_on_break ?? false,
    has_open_session: payload?.has_open_session ?? false,
    status: payload?.status || 'OUT',
    label: payload?.label || 'Doctor Out',
    time: payload?.time || null,
    started_at: payload?.started_at || null,
    break_started_at: payload?.break_started_at || null,
    ended_at: payload?.ended_at || null,
    doctor_name: payload?.doctor_name || null,
    branch_name: payload?.branch_name || null,
    doctor_id: payload?.doctor_id || null,
    branch_id: payload?.branch_id || null,
    slot_id: payload?.slot_id || null,
    session_id: payload?.session_id || null,
    source: payload?.source || 'MANUAL',
    updated_at: payload?.updated_at || null,
    ...meta,
});

const getRequestedBranchId = (req) => {
    if (req.body?.branch_id !== undefined && req.body?.branch_id !== null) {
        return toPositiveInt(req.body.branch_id);
    }

    if (req.query?.branch_id !== undefined && req.query?.branch_id !== null) {
        return toPositiveInt(req.query.branch_id);
    }

    return req.selectedBranchId || null;
};

const getRequestedDoctorId = (req) => {
    if (req.body?.doctor_id !== undefined && req.body?.doctor_id !== null) {
        return toPositiveInt(req.body.doctor_id);
    }

    if (req.query?.doctor_id !== undefined && req.query?.doctor_id !== null) {
        return toPositiveInt(req.query.doctor_id);
    }

    return null;
};

const getRequestedSlotId = (req) => {
    if (req.body?.slot_id !== undefined && req.body?.slot_id !== null) {
        return toPositiveInt(req.body.slot_id);
    }

    if (req.query?.slot_id !== undefined && req.query?.slot_id !== null) {
        return toPositiveInt(req.query.slot_id);
    }

    return null;
};

const hasExplicitBranchId = (req) => (
    (req.body?.branch_id !== undefined && req.body?.branch_id !== null)
    || (req.query?.branch_id !== undefined && req.query?.branch_id !== null)
);

const hasExplicitDoctorId = (req) => (
    (req.body?.doctor_id !== undefined && req.body?.doctor_id !== null)
    || (req.query?.doctor_id !== undefined && req.query?.doctor_id !== null)
);

const startSessionInternal = async ({ req, res, doctorId, branchId, slotId, note }) => {
    if (hasExplicitBranchId(req) && !branchId) {
        throw new AppError('branch_id must be a positive integer', 400);
    }

    if (hasExplicitDoctorId(req) && !doctorId) {
        throw new AppError('doctor_id must be a positive integer', 400);
    }

    const result = await startDoctorSession({
        doctorId,
        branchId,
        slotId,
        note,
        actorUserId: req.user.id,
        actorRole: req.user.role_code,
        ...getClientMetadata(req),
    });

    const realtimeQueueSessions = result.resumedQueueSessions?.length
        ? result.resumedQueueSessions
        : await listTodayLiveQueueSessionsForBroadcast({
            branchId: result.payload?.branch_id || req.selectedBranchId || branchId || null,
        });

    for (const queueSession of realtimeQueueSessions || []) {
        await emitLiveQueueEvent({
            branchId: queueSession.branchId,
            slotId: queueSession.slotId,
            appointmentDate: queueSession.appointmentDate,
            eventName: 'doctor-session-started',
            reason: req.user?.role_code === 'REC'
                ? 'DOCTOR_SESSION_RESUMED_FROM_RECEPTIONIST_DASHBOARD'
                : 'DOCTOR_SESSION_RESUMED_FROM_DOCTOR_DASHBOARD',
        });
    }

    emitDoctorSessionUpdateToLiveQueue({
        payload: result.payload,
        queueSessions: realtimeQueueSessions || [],
    });

    return res.status(200).json({
        success: true,
        message: result.changed ? 'Doctor session started successfully' : 'Doctor session is already active',
        data: result.payload,
    });
};

const pauseSessionInternal = async ({ req, res, doctorId, branchId, slotId, note }) => {
    if (hasExplicitDoctorId(req) && !doctorId) {
        throw new AppError('doctor_id must be a positive integer', 400);
    }

    const result = await pauseDoctorSession({
        doctorId,
        branchId,
        slotId,
        note,
        actorUserId: req.user.id,
        actorRole: req.user.role_code,
        ...getClientMetadata(req),
    });

    const realtimeQueueSessions = result.pausedQueueSessions?.length
        ? result.pausedQueueSessions
        : await listTodayLiveQueueSessionsForBroadcast({
            branchId: result.payload?.branch_id || req.selectedBranchId || null,
        });

    for (const queueSession of realtimeQueueSessions || []) {
        await emitLiveQueueEvent({
            branchId: queueSession.branchId,
            slotId: queueSession.slotId,
            appointmentDate: queueSession.appointmentDate,
            eventName: 'doctor-session-completed',
            reason: req.user?.role_code === 'REC'
                ? 'DOCTOR_SESSION_PAUSED_FROM_RECEPTIONIST_DASHBOARD'
                : 'DOCTOR_SESSION_PAUSED_FROM_DOCTOR_DASHBOARD',
        });
    }

    emitDoctorSessionUpdateToLiveQueue({
        payload: result.payload,
        queueSessions: realtimeQueueSessions || [],
    });

    return res.status(200).json({
        success: true,
        message: result.changed ? 'Doctor session paused successfully' : 'Doctor session is already paused',
        data: result.payload,
    });
};

const breakSessionInternal = async ({ req, res, doctorId, branchId, slotId, note }) => {
    if (hasExplicitDoctorId(req) && !doctorId) {
        throw new AppError('doctor_id must be a positive integer', 400);
    }

    const result = await takeDoctorBreak({
        doctorId,
        branchId,
        slotId,
        note,
        actorUserId: req.user.id,
        actorRole: req.user.role_code,
        ...getClientMetadata(req),
    });

    const realtimeQueueSessions = result.pausedQueueSessions?.length
        ? result.pausedQueueSessions
        : await listTodayLiveQueueSessionsForBroadcast({
            branchId: result.payload?.branch_id || req.selectedBranchId || null,
        });

    for (const queueSession of realtimeQueueSessions || []) {
        await emitLiveQueueEvent({
            branchId: queueSession.branchId,
            slotId: queueSession.slotId,
            appointmentDate: queueSession.appointmentDate,
            eventName: 'doctor-session-break-started',
            reason: req.user?.role_code === 'REC'
                ? 'DOCTOR_SESSION_BREAK_FROM_RECEPTIONIST_DASHBOARD'
                : 'DOCTOR_SESSION_BREAK_FROM_DOCTOR_DASHBOARD',
        });
    }

    emitDoctorSessionUpdateToLiveQueue({
        payload: result.payload,
        queueSessions: realtimeQueueSessions || [],
    });

    return res.status(200).json({
        success: true,
        message: result.changed ? 'Doctor break started successfully' : 'Doctor is already on break or inactive',
        data: result.payload,
    });
};

const resumeBreakInternal = async ({ req, res, doctorId, branchId, slotId, note }) => {
    if (hasExplicitDoctorId(req) && !doctorId) {
        throw new AppError('doctor_id must be a positive integer', 400);
    }

    const result = await resumeDoctorBreak({
        doctorId,
        branchId,
        slotId,
        note,
        actorUserId: req.user.id,
        actorRole: req.user.role_code,
        ...getClientMetadata(req),
    });

    const realtimeQueueSessions = result.resumedQueueSessions?.length
        ? result.resumedQueueSessions
        : await listTodayLiveQueueSessionsForBroadcast({
            branchId: result.payload?.branch_id || req.selectedBranchId || null,
        });

    for (const queueSession of realtimeQueueSessions || []) {
        await emitLiveQueueEvent({
            branchId: queueSession.branchId,
            slotId: queueSession.slotId,
            appointmentDate: queueSession.appointmentDate,
            eventName: 'doctor-session-break-resumed',
            reason: req.user?.role_code === 'REC'
                ? 'DOCTOR_SESSION_BREAK_RESUMED_FROM_RECEPTIONIST_DASHBOARD'
                : 'DOCTOR_SESSION_BREAK_RESUMED_FROM_DOCTOR_DASHBOARD',
        });
    }

    emitDoctorSessionUpdateToLiveQueue({
        payload: result.payload,
        queueSessions: realtimeQueueSessions || [],
    });

    return res.status(200).json({
        success: true,
        message: result.changed ? 'Doctor resumed from break successfully' : 'Doctor is not currently on break',
        data: result.payload,
    });
};

const startSession = asyncHandler(async (req, res) => {
    const branchId = getRequestedBranchId(req);
    const slotId = getRequestedSlotId(req);
    const note = req.body?.note ? String(req.body.note).trim() : null;

    return startSessionInternal({
        req,
        res,
        doctorId: req.user.id,
        branchId,
        slotId,
        note,
    });
});

const pauseSession = asyncHandler(async (req, res) => {
    const branchId = getRequestedBranchId(req);
    const slotId = getRequestedSlotId(req);
    const note = req.body?.note ? String(req.body.note).trim() : null;

    return pauseSessionInternal({
        req,
        res,
        doctorId: req.user.id,
        branchId,
        slotId,
        note,
    });
});

const startBreak = asyncHandler(async (req, res) => {
    const branchId = getRequestedBranchId(req);
    const slotId = getRequestedSlotId(req);
    const note = req.body?.note ? String(req.body.note).trim() : null;

    return breakSessionInternal({
        req,
        res,
        doctorId: req.user.id,
        branchId,
        slotId,
        note,
    });
});

const resumeBreak = asyncHandler(async (req, res) => {
    const branchId = getRequestedBranchId(req);
    const slotId = getRequestedSlotId(req);
    const note = req.body?.note ? String(req.body.note).trim() : null;

    return resumeBreakInternal({
        req,
        res,
        doctorId: req.user.id,
        branchId,
        slotId,
        note,
    });
});

const getOwnSessionStatus = asyncHandler(async (req, res) => {
    const status = await getDoctorSessionStatus({ doctorId: req.user.id });
    const selectedBranchId = req.selectedBranchId || null;

    return res.status(200).json({
        success: true,
        message: 'Doctor session status fetched successfully',
        data: buildSessionStatusResponse(status, {
            requested_branch_id: selectedBranchId,
            doctor_active_in_selected_branch: selectedBranchId
                ? Number(status?.branch_id || 0) === Number(selectedBranchId) && Boolean(status?.is_doctor_available)
                : Boolean(status?.is_doctor_available),
        }),
    });
});

const startSessionByReceptionist = asyncHandler(async (req, res) => {
    const branchId = getRequestedBranchId(req);
    const slotId = getRequestedSlotId(req);
    const requestedDoctorId = getRequestedDoctorId(req);
    const note = req.body?.note ? String(req.body.note).trim() : null;

    if (!branchId) {
        throw new AppError('branch_id is required to start doctor session from receptionist module', 400);
    }

    if (hasExplicitDoctorId(req) && !requestedDoctorId) {
        throw new AppError('doctor_id must be a positive integer', 400);
    }

    const doctorId = await resolveDoctorSessionTargetDoctorId({
        doctorId: requestedDoctorId,
        branchId,
    });

    return startSessionInternal({
        req,
        res,
        doctorId,
        branchId,
        slotId,
        note,
    });
});

const pauseSessionByReceptionist = asyncHandler(async (req, res) => {
    const branchId = getRequestedBranchId(req);
    const slotId = getRequestedSlotId(req);
    const requestedDoctorId = getRequestedDoctorId(req);
    const note = req.body?.note ? String(req.body.note).trim() : null;

    if (!branchId) {
        throw new AppError('branch_id is required to pause doctor session from receptionist module', 400);
    }

    if (hasExplicitDoctorId(req) && !requestedDoctorId) {
        throw new AppError('doctor_id must be a positive integer', 400);
    }

    const doctorId = await resolveDoctorSessionTargetDoctorId({
        doctorId: requestedDoctorId,
        branchId,
    });

    return pauseSessionInternal({
        req,
        res,
        doctorId,
        branchId,
        slotId,
        note,
    });
});

const getSessionStatusForReceptionist = asyncHandler(async (req, res) => {
    const branchId = getRequestedBranchId(req);
    const requestedDoctorId = getRequestedDoctorId(req);

    if (!branchId) {
        throw new AppError('branch_id is required to fetch receptionist session status', 400);
    }

    if (hasExplicitDoctorId(req) && !requestedDoctorId) {
        throw new AppError('doctor_id must be a positive integer', 400);
    }

    const doctorId = await resolveDoctorSessionTargetDoctorId({
        doctorId: requestedDoctorId,
        branchId,
    });
    const status = await getDoctorSessionStatus({ doctorId });

    return res.status(200).json({
        success: true,
        message: 'Receptionist doctor session status fetched successfully',
        data: buildSessionStatusResponse(status, {
            requested_branch_id: branchId,
            doctor_active_in_selected_branch: Number(status?.branch_id || 0) === Number(branchId) && Boolean(status?.is_doctor_available),
        }),
    });
});

const listSessionLogs = asyncHandler(async (req, res) => {
    const fromDate = req.query.from_date ? String(req.query.from_date).trim() : null;
    const toDate = req.query.to_date ? String(req.query.to_date).trim() : null;
    const limit = req.query.limit !== undefined ? toPositiveInt(req.query.limit) : 100;

    if (fromDate && !isValidDateString(fromDate)) {
        throw new AppError('from_date must be in YYYY-MM-DD format', 400);
    }

    if (toDate && !isValidDateString(toDate)) {
        throw new AppError('to_date must be in YYYY-MM-DD format', 400);
    }

    const logs = await getDoctorSessionLogs({
        doctorId: req.user.id,
        fromDate,
        toDate,
        limit: limit || 100,
    });

    return res.status(200).json({
        success: true,
        message: 'Doctor session logs fetched successfully',
        data: logs,
        meta: {
            total: logs.length,
            filters: {
                from_date: fromDate,
                to_date: toDate,
                limit: limit || 100,
            },
        },
    });
});

const getPublicStatus = asyncHandler(async (req, res) => {
    const doctorId = req.query.doctor_id !== undefined ? toPositiveInt(req.query.doctor_id) : null;
    const branchId = req.query.branch_id !== undefined ? toPositiveInt(req.query.branch_id) : null;

    if (req.query.doctor_id !== undefined && !doctorId) {
        throw new AppError('doctor_id must be a positive integer', 400);
    }

    if (req.query.branch_id !== undefined && !branchId) {
        throw new AppError('branch_id must be a positive integer', 400);
    }

    const status = await getDoctorSessionStatus({ doctorId, branchId });

    return res.status(200).json({
        success: true,
        message: 'Public doctor status fetched successfully',
        data: buildPublicDoctorStatus(status),
        meta: {
            filters: {
                doctor_id: doctorId,
                branch_id: branchId,
            },
        },
    });
});

module.exports = {
    getOwnSessionStatus,
    startSession,
    startBreak,
    resumeBreak,
    pauseSession,
    startSessionByReceptionist,
    pauseSessionByReceptionist,
    getSessionStatusForReceptionist,
    listSessionLogs,
    getPublicStatus,
};
