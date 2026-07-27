const { query, withTransaction } = require('../config/db');
const AppError = require('../utils/AppError');
const { emitDoctorSessionUpdate } = require('../utils/realtime');
const {
    scheduleAutoCallNext,
    cancelScheduledAutoCallNext,
    DEFAULT_RESUME_AUTO_CALL_DELAY_MS,
} = require('./liveQueueAutomationService');
const {
    ACTIVE_QUEUE_STATUSES,
    recalculateLiveRuntimeProjection,
    listBranchSlotBlockContexts,
    ensureQueueSession,
    parseMysqlDateTime,
    formatDateTimeForSql,
} = require('./liveQueueService');

const DOCTOR_SESSION_STATUS = {
    IN: 'IN',
    BREAK: 'BREAK',
    OUT: 'OUT',
};

const SESSION_ACTION = {
    START_SESSION: 'START_SESSION',
    TAKE_BREAK: 'TAKE_BREAK',
    RESUME_BREAK: 'RESUME_BREAK',
    PAUSE_SESSION: 'PAUSE_SESSION',
};

const toPositiveInt = (value) => {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) {
        return null;
    }

    return parsed;
};

const getExecutor = (connection = null) => async (sql, params = []) => {
    if (connection) {
        const [rows] = await connection.execute(sql, params);
        return rows;
    }

    return query(sql, params);
};

const pad = (value) => String(value).padStart(2, '0');

const formatDateToSqlDate = (date = new Date()) => [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
].join('-');

const LIVE_QUEUE_SESSION_STATUS = {
    NOT_STARTED: 'NOT_STARTED',
    RUNNING: 'RUNNING',
    COMPLETED: 'COMPLETED',
    PAUSED: 'PAUSED',
};

const ACTIVE_TARGETABLE_QUEUE_SESSION_STATUSES = [
    LIVE_QUEUE_SESSION_STATUS.RUNNING,
    LIVE_QUEUE_SESSION_STATUS.PAUSED,
    LIVE_QUEUE_SESSION_STATUS.NOT_STARTED,
];

const getClientMetadata = (req) => ({
    ipAddress: req.ip || req.headers['x-forwarded-for'] || null,
    userAgent: req.headers['user-agent'] ? String(req.headers['user-agent']).slice(0, 255) : null,
});

const mapDoctorSessionPayload = (row) => {
    if (!row) {
        return {
            is_doctor_available: false,
            is_on_break: false,
            has_open_session: false,
            status: DOCTOR_SESSION_STATUS.OUT,
            label: 'Doctor Out',
            time: null,
            started_at: null,
            ended_at: null,
            doctor_name: null,
            branch_name: null,
            session_id: null,
            slot_id: null,
        };
    }

    const isDoctorAvailable = row.session_status === DOCTOR_SESSION_STATUS.IN;
    const isOnBreak = row.session_status === DOCTOR_SESSION_STATUS.BREAK;
    const hasOpenSession = isDoctorAvailable || isOnBreak;
    const time = isDoctorAvailable
        ? (row.started_at || null)
        : (
            isOnBreak
                ? (row.break_started_at || row.started_at || null)
                : (row.ended_at || row.started_at || null)
        );

    return {
        is_doctor_available: isDoctorAvailable,
        is_on_break: isOnBreak,
        has_open_session: hasOpenSession,
        status: row.session_status,
        label: isDoctorAvailable ? 'Doctor In' : (isOnBreak ? 'Doctor On Break' : 'Doctor Out'),
        time,
        started_at: row.started_at || null,
        break_started_at: row.break_started_at || null,
        ended_at: row.ended_at || null,
        doctor_name: row.doctor_name || null,
        branch_name: row.branch_name || null,
        session_id: row.doctor_session_id || null,
        doctor_id: row.doctor_id || null,
        branch_id: row.branch_id || null,
        slot_id: row.slot_id ? Number(row.slot_id) : null,
        source: row.source || 'MANUAL',
        updated_at: row.updated_at || row.created_at || null,
    };
};

const resolveDoctorSessionSlotId = async (connection, {
    branchId,
    slotId = null,
    appointmentDate,
    referenceDateTime = new Date(),
}) => {
    const normalizedBranchId = toPositiveInt(branchId);
    const normalizedSlotId = slotId ? toPositiveInt(slotId) : null;

    if (!normalizedBranchId) {
        return null;
    }

    if (normalizedSlotId) {
        return normalizedSlotId;
    }

    const resolvedReferenceDate = referenceDateTime instanceof Date && !Number.isNaN(referenceDateTime.getTime())
        ? referenceDateTime
        : new Date();
    const referenceTime = [
        pad(resolvedReferenceDate.getHours()),
        pad(resolvedReferenceDate.getMinutes()),
        pad(resolvedReferenceDate.getSeconds()),
    ].join(':');

    const [rows] = await connection.execute(
        `SELECT
            a.fk_slot_id AS slot_id,
            s.start_time,
            MIN(a.checked_in_at) AS first_checked_in_at,
            MIN(COALESCE(a.live_estimated_start_at, a.planned_start_at, a.checked_in_at)) AS first_runtime_at
         FROM tbl_appointments a
         JOIN master_slots s ON s.id = a.fk_slot_id
         WHERE a.fk_branch_id = ?
           AND a.appointment_date = ?
           AND a.is_active = 1
           AND a.status <> 'Cancelled'
           AND a.queue_status IN (${ACTIVE_QUEUE_STATUSES.map(() => '?').join(', ')})
           AND a.checked_in_at IS NOT NULL
         GROUP BY a.fk_slot_id, s.start_time
         ORDER BY s.start_time ASC,
                  first_checked_in_at ASC,
                  first_runtime_at ASC,
                  a.fk_slot_id ASC
         LIMIT 1`,
        [
            normalizedBranchId,
            appointmentDate,
            ...ACTIVE_QUEUE_STATUSES,
        ]
    );

    if (rows.length > 0 && rows[0].slot_id) {
        return Number(rows[0].slot_id);
    }

    const [currentSlotRows] = await connection.execute(
        `SELECT id AS slot_id
         FROM master_slots
         WHERE fk_branch_id = ?
           AND is_active = 1
           AND start_time <= ?
           AND end_time >= ?
         ORDER BY start_time ASC, id ASC
         LIMIT 1`,
        [normalizedBranchId, referenceTime, referenceTime]
    );

    if (currentSlotRows.length > 0 && currentSlotRows[0].slot_id) {
        return Number(currentSlotRows[0].slot_id);
    }

    const [upcomingSlotRows] = await connection.execute(
        `SELECT id AS slot_id
         FROM master_slots
         WHERE fk_branch_id = ?
           AND is_active = 1
           AND start_time > ?
         ORDER BY start_time ASC, id ASC
         LIMIT 1`,
        [normalizedBranchId, referenceTime]
    );

    return upcomingSlotRows.length > 0 && upcomingSlotRows[0].slot_id
        ? Number(upcomingSlotRows[0].slot_id)
        : null;
};

const resolveDoctorVisibleSlotId = async ({
    doctorId,
    branchId,
    appointmentDate,
    slotId = null,
    connection = null,
    referenceDateTime = new Date(),
}) => {
    const execute = getExecutor(connection);
    const normalizedDoctorId = toPositiveInt(doctorId);
    const normalizedBranchId = toPositiveInt(branchId);
    const normalizedSlotId = slotId ? toPositiveInt(slotId) : null;

    if (!normalizedBranchId) {
        return null;
    }

    if (normalizedSlotId) {
        return normalizedSlotId;
    }

    if (normalizedDoctorId) {
        const activeSessionRows = await execute(
            `SELECT fk_slot_id AS slot_id
             FROM tbl_doctor_live_sessions
             WHERE doctor_id = ?
               AND fk_branch_id = ?
               AND session_status IN ('IN', 'BREAK')
               AND fk_slot_id IS NOT NULL
             ORDER BY started_at DESC, id DESC
             LIMIT 1`,
            [normalizedDoctorId, normalizedBranchId]
        );

        if (activeSessionRows.length > 0 && activeSessionRows[0].slot_id) {
            return Number(activeSessionRows[0].slot_id);
        }
    }

    const resolvedReferenceDate = referenceDateTime instanceof Date && !Number.isNaN(referenceDateTime.getTime())
        ? referenceDateTime
        : new Date();
    const resolvedAppointmentDate = appointmentDate || formatDateToSqlDate(resolvedReferenceDate);

    if (connection) {
        return resolveDoctorSessionSlotId(connection, {
            branchId: normalizedBranchId,
            slotId: normalizedSlotId,
            appointmentDate: resolvedAppointmentDate,
            referenceDateTime: resolvedReferenceDate,
        });
    }

    return withTransaction(async (transactionConnection) => resolveDoctorSessionSlotId(transactionConnection, {
        branchId: normalizedBranchId,
        slotId: normalizedSlotId,
        appointmentDate: resolvedAppointmentDate,
        referenceDateTime: resolvedReferenceDate,
    }));
};

const getDoctorSessionStatus = async ({ doctorId = null, branchId = null, connection = null } = {}) => {
    const execute = getExecutor(connection);
    const conditions = [];
    const params = [];

    const normalizedDoctorId = doctorId ? toPositiveInt(doctorId) : null;
    const normalizedBranchId = branchId ? toPositiveInt(branchId) : null;

    if (doctorId !== null && !normalizedDoctorId) {
        throw new AppError('doctor_id must be a positive integer', 400);
    }

    if (branchId !== null && !normalizedBranchId) {
        throw new AppError('branch_id must be a positive integer', 400);
    }

    if (normalizedDoctorId) {
        conditions.push('s.doctor_id = ?');
        params.push(normalizedDoctorId);
    }

    if (normalizedBranchId) {
        conditions.push('s.fk_branch_id = ?');
        params.push(normalizedBranchId);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const rows = await execute(
        `SELECT
            s.id AS doctor_session_id,
            s.doctor_id,
            s.fk_branch_id AS branch_id,
            s.fk_slot_id AS slot_id,
            s.session_status,
            s.started_at,
            s.break_started_at,
            s.ended_at,
            s.note,
            s.source,
            s.created_at,
            s.updated_at,
            d.full_name AS doctor_name,
            b.branch_name
         FROM tbl_doctor_live_sessions s
         JOIN master_users d ON d.id = s.doctor_id
         LEFT JOIN master_clinic_branches b ON b.id = s.fk_branch_id
         ${whereClause}
         ORDER BY CASE
                    WHEN s.session_status = 'IN' THEN 0
                    WHEN s.session_status = 'BREAK' THEN 1
                    ELSE 2
                  END ASC,
                  COALESCE(s.ended_at, s.started_at, s.created_at) DESC,
                  s.id DESC
         LIMIT 1`,
        params
    );

    return mapDoctorSessionPayload(rows[0] || null);
};

const resolveDoctorSessionTargetDoctorId = async ({ doctorId = null, branchId = null, connection = null } = {}) => {
    const execute = getExecutor(connection);
    const normalizedDoctorId = doctorId ? toPositiveInt(doctorId) : null;
    const normalizedBranchId = branchId ? toPositiveInt(branchId) : null;

    if (doctorId !== null && !normalizedDoctorId) {
        throw new AppError('doctor_id must be a positive integer', 400);
    }

    if (branchId !== null && !normalizedBranchId) {
        throw new AppError('branch_id must be a positive integer', 400);
    }

    if (normalizedDoctorId) {
        const params = [normalizedDoctorId];
        const branchJoin = normalizedBranchId
            ? `JOIN tbl_user_branch_access uba
               ON uba.user_id = u.id
              AND uba.branch_id = ?
              AND uba.is_active = 1`
            : '';

        if (normalizedBranchId) {
            params.push(normalizedBranchId);
        }

        const rows = await execute(
            `SELECT u.id
             FROM master_users u
             ${branchJoin}
             WHERE u.id = ?
               AND u.is_active = 1
               AND u.role = 'DOC'
             LIMIT 1`,
            normalizedBranchId ? [normalizedBranchId, normalizedDoctorId] : params
        );

        if (!rows.length) {
            throw new AppError('Doctor not found for the requested branch', 404);
        }

        return Number(rows[0].id);
    }

    if (!normalizedBranchId) {
        throw new AppError('branch_id is required when doctor_id is not provided', 400);
    }

    const activeDoctors = await execute(
        `SELECT s.doctor_id, d.full_name AS doctor_name
         FROM tbl_doctor_live_sessions s
         JOIN master_users d ON d.id = s.doctor_id
         WHERE s.fk_branch_id = ?
           AND s.session_status = 'IN'
           AND d.is_active = 1
           AND d.role = 'DOC'
         ORDER BY s.started_at DESC, s.id DESC
         LIMIT 2`,
        [normalizedBranchId]
    );

    if (activeDoctors.length === 1) {
        return Number(activeDoctors[0].doctor_id);
    }

    if (activeDoctors.length > 1) {
        throw new AppError('Multiple active doctors found for this branch. Please pass doctor_id explicitly.', 409);
    }

    const branchDoctors = await execute(
        `SELECT u.id, u.full_name AS doctor_name
         FROM master_users u
         JOIN tbl_user_branch_access uba
           ON uba.user_id = u.id
          AND uba.branch_id = ?
          AND uba.is_active = 1
         WHERE u.is_active = 1
           AND u.role = 'DOC'
         ORDER BY u.id ASC
         LIMIT 2`,
        [normalizedBranchId]
    );

    if (!branchDoctors.length) {
        throw new AppError('No doctor is assigned to the selected branch', 404);
    }

    if (branchDoctors.length > 1) {
        throw new AppError('Multiple doctors are assigned to this branch. Please pass doctor_id explicitly.', 409);
    }

    return Number(branchDoctors[0].id);
};

const getDoctorSessionLogs = async ({ doctorId, fromDate = null, toDate = null, limit = 100 }) => {
    const normalizedDoctorId = toPositiveInt(doctorId);
    if (!normalizedDoctorId) {
        throw new AppError('doctor_id must be a positive integer', 400);
    }

    const parsedLimit = toPositiveInt(limit) || 100;
    const finalLimit = Math.min(parsedLimit, 500);
    const params = [normalizedDoctorId];
    let whereClause = 'WHERE l.doctor_id = ?';

    if (fromDate) {
        whereClause += ' AND DATE(l.created_at) >= ?';
        params.push(fromDate);
    }

    if (toDate) {
        whereClause += ' AND DATE(l.created_at) <= ?';
        params.push(toDate);
    }

    params.push(finalLimit);

    return query(
        `SELECT
            l.id AS log_id,
            l.doctor_session_id,
            l.doctor_id,
            d.full_name AS doctor_name,
            l.fk_branch_id AS branch_id,
            b.branch_name,
            l.old_status,
            l.new_status,
            l.action,
            l.note,
            l.changed_by_user_id,
            l.changed_by_role,
            l.source,
            l.ip_address,
            l.user_agent,
            l.created_at
         FROM tbl_doctor_live_session_logs l
         JOIN master_users d ON d.id = l.doctor_id
         LEFT JOIN master_clinic_branches b ON b.id = l.fk_branch_id
         ${whereClause}
         ORDER BY l.created_at DESC, l.id DESC
         LIMIT ?`,
        params
    );
};

const logDoctorSessionChange = async (connection, {
    doctorSessionId,
    doctorId,
    branchId = null,
    oldStatus = null,
    newStatus,
    action,
    note = null,
    changedByUserId = null,
    changedByRole = null,
    source = 'MANUAL',
    ipAddress = null,
    userAgent = null,
}) => {
    await connection.execute(
        `INSERT INTO tbl_doctor_live_session_logs
         (doctor_session_id, doctor_id, fk_branch_id, old_status, new_status, action, note, changed_by_user_id, changed_by_role, source, ip_address, user_agent)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            doctorSessionId,
            doctorId,
            branchId,
            oldStatus,
            newStatus,
            action,
            note,
            changedByUserId,
            changedByRole,
            source,
            ipAddress,
            userAgent,
        ]
    );
};

const syncLiveQueueSessionsForDoctorPause = async (connection, {
    branchId = null,
    actorUserId = null,
    slotIds = [],
    appointmentDate = null,
}) => {
    const params = [appointmentDate || formatDateToSqlDate(new Date())];
    let branchCondition = '';
    let slotCondition = '';

    if (branchId) {
        branchCondition = 'AND s.fk_branch_id = ?';
        params.push(branchId);
    }

    const normalizedSlotIds = (Array.isArray(slotIds) ? slotIds : [])
        .map((value) => toPositiveInt(value))
        .filter(Boolean);

    if (normalizedSlotIds.length > 0) {
        slotCondition = `AND s.fk_slot_id IN (${normalizedSlotIds.map(() => '?').join(', ')})`;
        params.push(...normalizedSlotIds);
    }

    const [rows] = await connection.execute(
        `SELECT
            s.id,
            s.current_appointment_id,
            s.current_token_number,
            s.fk_branch_id,
            s.fk_slot_id,
            s.appointment_date,
            a.queue_status
         FROM tbl_live_queue_sessions s
         LEFT JOIN tbl_appointments a
           ON a.appointment_id = s.current_appointment_id
         WHERE s.appointment_date = ?
           ${branchCondition}
           ${slotCondition}
           AND s.session_status IN (?, ?)
         FOR UPDATE`,
        [
            ...params,
            LIVE_QUEUE_SESSION_STATUS.NOT_STARTED,
            LIVE_QUEUE_SESSION_STATUS.RUNNING,
        ]
    );

    for (const row of rows) {
        const hasInProgressAppointment = Number(row.current_appointment_id) > 0 && row.queue_status === 'IN_PROGRESS';

        await connection.execute(
            `UPDATE tbl_live_queue_sessions
             SET session_status = ?,
                 current_appointment_id = CASE
                     WHEN ? THEN current_appointment_id
                     ELSE NULL
                 END,
                 current_token_number = CASE
                     WHEN ? THEN current_token_number
                     ELSE NULL
                 END,
                 updated_by = COALESCE(?, updated_by)
             WHERE id = ?`,
            [
                LIVE_QUEUE_SESSION_STATUS.PAUSED,
                hasInProgressAppointment ? 1 : 0,
                hasInProgressAppointment ? 1 : 0,
                actorUserId,
                row.id,
            ]
        );
    }

    return rows.map((row) => ({
        branchId: Number(row.fk_branch_id),
        slotId: Number(row.fk_slot_id),
        appointmentDate: row.appointment_date,
    }));
};

const syncLiveQueueSessionsForDoctorResume = async (connection, {
    branchId = null,
    actorUserId = null,
    slotIds = [],
    appointmentDate = null,
    shiftSessionStartedByMinutes = 0,
}) => {
    const normalizedAppointmentDate = appointmentDate || formatDateToSqlDate(new Date());
    const resumeReferenceAt = new Date();
    const params = [appointmentDate || formatDateToSqlDate(new Date())];
    let branchCondition = '';
    let slotCondition = '';

    if (branchId) {
        branchCondition = 'AND s.fk_branch_id = ?';
        params.push(branchId);
    }

    const normalizedSlotIds = (Array.isArray(slotIds) ? slotIds : [])
        .map((value) => toPositiveInt(value))
        .filter(Boolean);

    if (branchId && normalizedSlotIds.length > 0) {
        for (const normalizedSlotId of normalizedSlotIds) {
            await ensureQueueSession(connection, {
                branchId,
                slotId: normalizedSlotId,
                appointmentDate: normalizedAppointmentDate,
                actorUserId,
            });
        }
    }

    if (normalizedSlotIds.length > 0) {
        slotCondition = `AND s.fk_slot_id IN (${normalizedSlotIds.map(() => '?').join(', ')})`;
        params.push(...normalizedSlotIds);
    }

    const [rows] = await connection.execute(
        `SELECT
            s.id,
            s.current_appointment_id,
            s.current_token_number,
            s.fk_branch_id,
            s.fk_slot_id,
            s.appointment_date,
            s.session_status,
            s.session_started_at,
            a.queue_status
         FROM tbl_live_queue_sessions s
         LEFT JOIN tbl_appointments a
           ON a.appointment_id = s.current_appointment_id
         WHERE s.appointment_date = ?
           ${branchCondition}
           ${slotCondition}
           AND s.session_status IN (?, ?, ?)
         FOR UPDATE`,
        [
            ...params,
            LIVE_QUEUE_SESSION_STATUS.PAUSED,
            LIVE_QUEUE_SESSION_STATUS.NOT_STARTED,
            LIVE_QUEUE_SESSION_STATUS.COMPLETED,
        ]
    );

    for (const row of rows) {
        const hasInProgressAppointment = Number(row.current_appointment_id) > 0 && row.queue_status === 'IN_PROGRESS';
        let resumeCurrentAppointmentId = hasInProgressAppointment ? Number(row.current_appointment_id) : null;
        let resumeCurrentTokenNumber = hasInProgressAppointment ? Number(row.current_token_number) : null;
        const currentSessionStartedAt = parseMysqlDateTime(row.session_started_at);
        const resumeBaseStartedAt = row.session_status === LIVE_QUEUE_SESSION_STATUS.PAUSED
            ? (currentSessionStartedAt || resumeReferenceAt)
            : resumeReferenceAt;
        const nextSessionStartedAt = Number(shiftSessionStartedByMinutes) > 0
            ? formatDateTimeForSql(
                new Date(
                    resumeBaseStartedAt.getTime()
                    + Number(shiftSessionStartedByMinutes) * 60 * 1000
                )
            )
            : formatDateTimeForSql(resumeBaseStartedAt);

        if (!resumeCurrentAppointmentId) {
            const [calledRows] = await connection.execute(
                `SELECT appointment_id, current_token_number
                 FROM tbl_appointments
                 WHERE fk_branch_id = ?
                   AND fk_slot_id = ?
                   AND appointment_date = ?
                   AND is_active = 1
                   AND status <> 'Cancelled'
                   AND queue_status = 'WAITING'
                   AND actual_called_at IS NOT NULL
                 ORDER BY actual_called_at ASC, current_token_number ASC
                 LIMIT 1
                 FOR UPDATE`,
                [row.fk_branch_id, row.fk_slot_id, row.appointment_date]
            );

            if (calledRows.length > 0) {
                resumeCurrentAppointmentId = Number(calledRows[0].appointment_id);
                resumeCurrentTokenNumber = Number(calledRows[0].current_token_number);
            }
        }

        await connection.execute(
            `UPDATE tbl_live_queue_sessions
             SET session_status = ?,
                 session_started_at = COALESCE(?, session_started_at),
                 session_ended_at = NULL,
                 current_appointment_id = CASE
                     WHEN ? THEN ?
                     ELSE NULL
                 END,
                 current_token_number = CASE
                     WHEN ? THEN ?
                     ELSE NULL
                 END,
                 updated_by = COALESCE(?, updated_by)
             WHERE id = ?`,
            [
                LIVE_QUEUE_SESSION_STATUS.RUNNING,
                nextSessionStartedAt,
                resumeCurrentAppointmentId ? 1 : 0,
                resumeCurrentAppointmentId,
                resumeCurrentAppointmentId ? 1 : 0,
                resumeCurrentTokenNumber,
                actorUserId,
                row.id,
            ]
        );

        row.current_appointment_id = resumeCurrentAppointmentId;
        row.current_token_number = resumeCurrentTokenNumber;
        row.queue_status = resumeCurrentAppointmentId
            ? (hasInProgressAppointment ? row.queue_status : 'WAITING')
            : row.queue_status;
    }

    return rows.map((row) => ({
        branchId: Number(row.fk_branch_id),
        slotId: Number(row.fk_slot_id),
        appointmentDate: row.appointment_date,
        hasInProgressAppointment: Number(row.current_appointment_id) > 0,
    }));
};

const startDoctorSession = async ({
    doctorId,
    branchId = null,
    slotId = null,
    note = null,
    actorUserId,
    actorRole,
    ipAddress = null,
    userAgent = null,
}) => {
    const normalizedDoctorId = toPositiveInt(doctorId);
    const normalizedBranchId = branchId ? toPositiveInt(branchId) : null;
    const normalizedSlotId = slotId ? toPositiveInt(slotId) : null;

    if (!normalizedDoctorId) {
        throw new AppError('doctor_id must be a positive integer', 400);
    }

    if (branchId !== null && !normalizedBranchId) {
        throw new AppError('branch_id must be a positive integer', 400);
    }

    if (slotId !== null && slotId !== undefined && !normalizedSlotId) {
        throw new AppError('slot_id must be a positive integer', 400);
    }

    const result = await withTransaction(async (connection) => {
        const referenceDateTime = new Date();
        const appointmentDate = formatDateToSqlDate(referenceDateTime);
        const [existingRows] = await connection.execute(
            `SELECT
                s.id AS doctor_session_id,
                s.doctor_id,
                s.fk_branch_id AS branch_id,
                s.fk_slot_id AS slot_id,
                s.session_status,
                s.started_at,
                s.break_started_at,
                s.ended_at,
                s.note,
                s.source,
                s.created_at,
                s.updated_at,
                d.full_name AS doctor_name,
                b.branch_name
             FROM tbl_doctor_live_sessions s
             JOIN master_users d ON d.id = s.doctor_id
             LEFT JOIN master_clinic_branches b ON b.id = s.fk_branch_id
             WHERE s.doctor_id = ?
               AND s.session_status IN ('IN', 'BREAK')
             ORDER BY s.started_at DESC, s.id DESC
             LIMIT 1
             FOR UPDATE`,
            [normalizedDoctorId]
        );

        if (existingRows.length > 0) {
            const activeSession = existingRows[0];
            const activeBranchId = activeSession.branch_id ? Number(activeSession.branch_id) : null;

            if (normalizedBranchId && activeBranchId && activeBranchId !== normalizedBranchId) {
                throw new AppError('Doctor is already active in another branch', 409, {
                    active_branch_id: activeBranchId,
                    active_branch_name: activeSession.branch_name || null,
                    doctor_id: normalizedDoctorId,
                });
            }

            return {
                changed: false,
                payload: mapDoctorSessionPayload(activeSession),
                resumedQueueSessions: [],
            };
        }

        const resolvedSlotId = normalizedBranchId
            ? await resolveDoctorSessionSlotId(connection, {
                branchId: normalizedBranchId,
                slotId: normalizedSlotId,
                appointmentDate,
            })
            : normalizedSlotId;

        const blockContexts = normalizedBranchId
            ? await listBranchSlotBlockContexts({
                connection,
                branchId: normalizedBranchId,
                appointmentDate,
                referenceDateTime,
                slotId: resolvedSlotId,
            })
            : { slots: [] };

        const resumedQueueSessions = await syncLiveQueueSessionsForDoctorResume(connection, {
            branchId: normalizedBranchId,
            actorUserId,
            appointmentDate,
            slotIds: (blockContexts.slots || []).map((slot) => slot.slotId),
        });

        const [insertResult] = await connection.execute(
            `INSERT INTO tbl_doctor_live_sessions
             (doctor_id, fk_branch_id, fk_slot_id, session_status, started_at, note, source, started_by_user_id, started_by_role)
             VALUES (?, ?, ?, 'IN', NOW(), ?, 'MANUAL', ?, ?)`,
            [normalizedDoctorId, normalizedBranchId, resolvedSlotId, note, actorUserId, actorRole]
        );

        const [createdRows] = await connection.execute(
            `SELECT
                s.id AS doctor_session_id,
                s.doctor_id,
                s.fk_branch_id AS branch_id,
                s.fk_slot_id AS slot_id,
                s.session_status,
                s.started_at,
                s.break_started_at,
                s.ended_at,
                s.note,
                s.source,
                s.created_at,
                s.updated_at,
                d.full_name AS doctor_name,
                b.branch_name
             FROM tbl_doctor_live_sessions s
             JOIN master_users d ON d.id = s.doctor_id
             LEFT JOIN master_clinic_branches b ON b.id = s.fk_branch_id
             WHERE s.id = ?
             LIMIT 1`,
            [insertResult.insertId]
        );

        await logDoctorSessionChange(connection, {
            doctorSessionId: insertResult.insertId,
            doctorId: normalizedDoctorId,
            branchId: normalizedBranchId,
            oldStatus: DOCTOR_SESSION_STATUS.OUT,
            newStatus: DOCTOR_SESSION_STATUS.IN,
            action: SESSION_ACTION.START_SESSION,
            note,
            changedByUserId: actorUserId,
            changedByRole: actorRole,
            source: 'MANUAL',
            ipAddress,
            userAgent,
        });

        return {
            changed: true,
            payload: mapDoctorSessionPayload(createdRows[0] || null),
            resumedQueueSessions,
        };
    });

    if (result.payload) {
        emitDoctorSessionUpdate(result.payload);
    }

    if (result.changed) {
        for (const queueSession of result.resumedQueueSessions || []) {
            if (!queueSession.hasInProgressAppointment) {
                await scheduleAutoCallNext({
                    branchId: queueSession.branchId,
                    slotId: queueSession.slotId,
                    appointmentDate: queueSession.appointmentDate,
                    actorUserId,
                    delayMs: DEFAULT_RESUME_AUTO_CALL_DELAY_MS,
                    reason: 'AUTO_CALL_NEXT_AFTER_SESSION_RESUME',
                });
            }

            await withTransaction(async (connection) => recalculateLiveRuntimeProjection(connection, {
                branchId: queueSession.branchId,
                slotId: queueSession.slotId,
                appointmentDate: queueSession.appointmentDate,
                actorUserId,
                actorIp: ipAddress,
            }));
        }
    }

    return result;
};

const takeDoctorBreak = async ({
    doctorId,
    branchId = null,
    slotId = null,
    note = null,
    actorUserId,
    actorRole,
    ipAddress = null,
    userAgent = null,
}) => {
    const normalizedDoctorId = toPositiveInt(doctorId);
    const normalizedBranchId = branchId ? toPositiveInt(branchId) : null;
    const normalizedSlotId = slotId ? toPositiveInt(slotId) : null;

    if (!normalizedDoctorId) {
        throw new AppError('doctor_id must be a positive integer', 400);
    }

    if (branchId !== null && !normalizedBranchId) {
        throw new AppError('branch_id must be a positive integer', 400);
    }

    if (slotId !== null && slotId !== undefined && !normalizedSlotId) {
        throw new AppError('slot_id must be a positive integer', 400);
    }

    const result = await withTransaction(async (connection) => {
        const activeSessionConditions = ['s.doctor_id = ?', `s.session_status IN ('IN', 'BREAK')`];
        const activeSessionParams = [normalizedDoctorId];

        if (normalizedBranchId) {
            activeSessionConditions.push('s.fk_branch_id = ?');
            activeSessionParams.push(normalizedBranchId);
        }

        const [existingRows] = await connection.execute(
            `SELECT
                s.id AS doctor_session_id,
                s.doctor_id,
                s.fk_branch_id AS branch_id,
                s.fk_slot_id AS slot_id,
                s.session_status,
                s.started_at,
                s.break_started_at,
                s.ended_at,
                s.note,
                s.source,
                s.created_at,
                s.updated_at,
                d.full_name AS doctor_name,
                b.branch_name
             FROM tbl_doctor_live_sessions s
             JOIN master_users d ON d.id = s.doctor_id
             LEFT JOIN master_clinic_branches b ON b.id = s.fk_branch_id
             WHERE ${activeSessionConditions.join(' AND ')}
             ORDER BY s.started_at DESC, s.id DESC
             LIMIT 1
             FOR UPDATE`,
            activeSessionParams
        );

        if (existingRows.length === 0) {
            return {
                changed: false,
                payload: await getDoctorSessionStatus({
                    doctorId: normalizedDoctorId,
                    branchId: normalizedBranchId,
                    connection,
                }),
                pausedQueueSessions: [],
            };
        }

        const activeSession = existingRows[0];
        if (activeSession.session_status === DOCTOR_SESSION_STATUS.BREAK) {
            return {
                changed: false,
                payload: mapDoctorSessionPayload(activeSession),
                pausedQueueSessions: [],
            };
        }

        const referenceDateTime = new Date();
        const appointmentDate = formatDateToSqlDate(referenceDateTime);
        const blockContexts = activeSession.branch_id
            ? await listBranchSlotBlockContexts({
                connection,
                branchId: Number(activeSession.branch_id),
                appointmentDate,
                referenceDateTime,
                slotId: activeSession.slot_id ? Number(activeSession.slot_id) : normalizedSlotId,
            })
            : { slots: [] };

        const pausedQueueSessions = await syncLiveQueueSessionsForDoctorPause(connection, {
            branchId: activeSession.branch_id ? Number(activeSession.branch_id) : null,
            actorUserId,
            appointmentDate,
            slotIds: (blockContexts.slots || []).map((slot) => slot.slotId),
        });

        await connection.execute(
            `UPDATE tbl_doctor_live_sessions
             SET session_status = ?,
                 break_started_at = NOW(),
                 note = COALESCE(?, note),
                 ended_at = NULL,
                 ended_by_user_id = NULL,
                 ended_by_role = NULL
             WHERE id = ?`,
            [DOCTOR_SESSION_STATUS.BREAK, note, activeSession.doctor_session_id]
        );

        await logDoctorSessionChange(connection, {
            doctorSessionId: activeSession.doctor_session_id,
            doctorId: normalizedDoctorId,
            branchId: activeSession.branch_id,
            oldStatus: activeSession.session_status,
            newStatus: DOCTOR_SESSION_STATUS.BREAK,
            action: SESSION_ACTION.TAKE_BREAK,
            note,
            changedByUserId: actorUserId,
            changedByRole: actorRole,
            source: 'MANUAL',
            ipAddress,
            userAgent,
        });

        return {
            changed: true,
            payload: await getDoctorSessionStatus({
                doctorId: normalizedDoctorId,
                branchId: normalizedBranchId,
                connection,
            }),
            pausedQueueSessions,
        };
    });

    if (result.payload) {
        emitDoctorSessionUpdate(result.payload);
    }

    for (const queueSession of result.pausedQueueSessions || []) {
        await cancelScheduledAutoCallNext({
            branchId: queueSession.branchId,
            slotId: queueSession.slotId,
            appointmentDate: queueSession.appointmentDate,
        });

        await withTransaction(async (connection) => recalculateLiveRuntimeProjection(connection, {
            branchId: queueSession.branchId,
            slotId: queueSession.slotId,
            appointmentDate: queueSession.appointmentDate,
            actorUserId,
            actorIp: ipAddress,
        }));
    }

    return result;
};

const resumeDoctorBreak = async ({
    doctorId,
    branchId = null,
    slotId = null,
    note = null,
    actorUserId,
    actorRole,
    ipAddress = null,
    userAgent = null,
}) => {
    const normalizedDoctorId = toPositiveInt(doctorId);
    const normalizedBranchId = branchId ? toPositiveInt(branchId) : null;
    const normalizedSlotId = slotId ? toPositiveInt(slotId) : null;

    if (!normalizedDoctorId) {
        throw new AppError('doctor_id must be a positive integer', 400);
    }

    if (branchId !== null && !normalizedBranchId) {
        throw new AppError('branch_id must be a positive integer', 400);
    }

    if (slotId !== null && slotId !== undefined && !normalizedSlotId) {
        throw new AppError('slot_id must be a positive integer', 400);
    }

    const result = await withTransaction(async (connection) => {
        const activeSessionConditions = ['s.doctor_id = ?', `s.session_status = ?`];
        const activeSessionParams = [normalizedDoctorId, DOCTOR_SESSION_STATUS.BREAK];

        if (normalizedBranchId) {
            activeSessionConditions.push('s.fk_branch_id = ?');
            activeSessionParams.push(normalizedBranchId);
        }

        const [existingRows] = await connection.execute(
            `SELECT
                s.id AS doctor_session_id,
                s.doctor_id,
                s.fk_branch_id AS branch_id,
                s.fk_slot_id AS slot_id,
                s.session_status,
                s.started_at,
                s.break_started_at,
                s.ended_at,
                s.note,
                s.source,
                s.created_at,
                s.updated_at,
                d.full_name AS doctor_name,
                b.branch_name
             FROM tbl_doctor_live_sessions s
             JOIN master_users d ON d.id = s.doctor_id
             LEFT JOIN master_clinic_branches b ON b.id = s.fk_branch_id
             WHERE ${activeSessionConditions.join(' AND ')}
             ORDER BY COALESCE(s.break_started_at, s.updated_at, s.started_at) DESC, s.id DESC
             LIMIT 1
             FOR UPDATE`,
            activeSessionParams
        );

        if (existingRows.length === 0) {
            return {
                changed: false,
                payload: await getDoctorSessionStatus({
                    doctorId: normalizedDoctorId,
                    branchId: normalizedBranchId,
                    connection,
                }),
                resumedQueueSessions: [],
            };
        }

        const breakSession = existingRows[0];
        const referenceDateTime = new Date();
        const appointmentDate = formatDateToSqlDate(referenceDateTime);
        const blockContexts = breakSession.branch_id
            ? await listBranchSlotBlockContexts({
                connection,
                branchId: Number(breakSession.branch_id),
                appointmentDate,
                referenceDateTime,
                slotId: breakSession.slot_id ? Number(breakSession.slot_id) : normalizedSlotId,
            })
            : { slots: [] };
        const breakStartedAt = parseMysqlDateTime(breakSession.break_started_at);
        const breakDelayMinutes = breakStartedAt
            ? Math.max(0, Math.round((referenceDateTime.getTime() - breakStartedAt.getTime()) / (60 * 1000)))
            : 0;

        const resumedQueueSessions = await syncLiveQueueSessionsForDoctorResume(connection, {
            branchId: breakSession.branch_id ? Number(breakSession.branch_id) : null,
            actorUserId,
            appointmentDate,
            slotIds: (blockContexts.slots || []).map((slot) => slot.slotId),
            shiftSessionStartedByMinutes: breakDelayMinutes,
        });

        await connection.execute(
            `UPDATE tbl_doctor_live_sessions
             SET session_status = ?,
                 break_started_at = NULL,
                 note = COALESCE(?, note)
             WHERE id = ?`,
            [DOCTOR_SESSION_STATUS.IN, note, breakSession.doctor_session_id]
        );

        await logDoctorSessionChange(connection, {
            doctorSessionId: breakSession.doctor_session_id,
            doctorId: normalizedDoctorId,
            branchId: breakSession.branch_id,
            oldStatus: DOCTOR_SESSION_STATUS.BREAK,
            newStatus: DOCTOR_SESSION_STATUS.IN,
            action: SESSION_ACTION.RESUME_BREAK,
            note,
            changedByUserId: actorUserId,
            changedByRole: actorRole,
            source: 'MANUAL',
            ipAddress,
            userAgent,
        });

        return {
            changed: true,
            payload: await getDoctorSessionStatus({
                doctorId: normalizedDoctorId,
                branchId: normalizedBranchId,
                connection,
            }),
            resumedQueueSessions,
        };
    });

    if (result.payload) {
        emitDoctorSessionUpdate(result.payload);
    }

    if (result.changed) {
        for (const queueSession of result.resumedQueueSessions || []) {
            if (!queueSession.hasInProgressAppointment) {
                await scheduleAutoCallNext({
                    branchId: queueSession.branchId,
                    slotId: queueSession.slotId,
                    appointmentDate: queueSession.appointmentDate,
                    actorUserId,
                    delayMs: DEFAULT_RESUME_AUTO_CALL_DELAY_MS,
                    reason: 'AUTO_CALL_NEXT_AFTER_BREAK_RESUME',
                });
            }

            await withTransaction(async (connection) => recalculateLiveRuntimeProjection(connection, {
                branchId: queueSession.branchId,
                slotId: queueSession.slotId,
                appointmentDate: queueSession.appointmentDate,
                actorUserId,
                actorIp: ipAddress,
            }));
        }
    }

    return result;
};

const pauseDoctorSession = async ({
    doctorId,
    branchId = null,
    slotId = null,
    note = null,
    actorUserId,
    actorRole,
    ipAddress = null,
    userAgent = null,
}) => {
    const normalizedDoctorId = toPositiveInt(doctorId);
    const normalizedBranchId = branchId ? toPositiveInt(branchId) : null;
    const normalizedSlotId = slotId ? toPositiveInt(slotId) : null;

    if (!normalizedDoctorId) {
        throw new AppError('doctor_id must be a positive integer', 400);
    }

    if (branchId !== null && !normalizedBranchId) {
        throw new AppError('branch_id must be a positive integer', 400);
    }

    if (slotId !== null && slotId !== undefined && !normalizedSlotId) {
        throw new AppError('slot_id must be a positive integer', 400);
    }

    const result = await withTransaction(async (connection) => {
        const activeSessionConditions = ['s.doctor_id = ?', `s.session_status IN ('IN', 'BREAK')`];
        const activeSessionParams = [normalizedDoctorId];

        if (normalizedBranchId) {
            activeSessionConditions.push('s.fk_branch_id = ?');
            activeSessionParams.push(normalizedBranchId);
        }

        const [existingRows] = await connection.execute(
            `SELECT
                s.id AS doctor_session_id,
                s.doctor_id,
                s.fk_branch_id AS branch_id,
                s.fk_slot_id AS slot_id,
                s.session_status,
                s.started_at,
                s.break_started_at,
                s.ended_at,
                s.note,
                s.source,
                s.created_at,
                s.updated_at,
                d.full_name AS doctor_name,
                b.branch_name
             FROM tbl_doctor_live_sessions s
             JOIN master_users d ON d.id = s.doctor_id
             LEFT JOIN master_clinic_branches b ON b.id = s.fk_branch_id
             WHERE ${activeSessionConditions.join(' AND ')}
             ORDER BY s.started_at DESC, s.id DESC
             LIMIT 1
             FOR UPDATE`,
            activeSessionParams
        );

        if (existingRows.length === 0) {
            return {
                changed: false,
                payload: await getDoctorSessionStatus({
                    doctorId: normalizedDoctorId,
                    branchId: normalizedBranchId,
                    connection,
                }),
                pausedQueueSessions: [],
            };
        }

        const activeSession = existingRows[0];
        const appointmentDate = formatDateToSqlDate(new Date());
        const blockContexts = activeSession.branch_id
            ? await listBranchSlotBlockContexts({
                connection,
                branchId: Number(activeSession.branch_id),
                appointmentDate,
                slotId: activeSession.slot_id ? Number(activeSession.slot_id) : normalizedSlotId,
            })
            : { slots: [] };

        const pausedQueueSessions = await syncLiveQueueSessionsForDoctorPause(connection, {
            branchId: activeSession.branch_id ? Number(activeSession.branch_id) : null,
            actorUserId,
            appointmentDate,
            slotIds: (blockContexts.slots || []).map((slot) => slot.slotId),
        });

        await connection.execute(
            `UPDATE tbl_doctor_live_sessions
             SET session_status = 'OUT',
                 break_started_at = NULL,
                 ended_at = NOW(),
                 note = COALESCE(?, note),
                 ended_by_user_id = ?,
                 ended_by_role = ?
             WHERE id = ?`,
            [note, actorUserId, actorRole, activeSession.doctor_session_id]
        );

        await logDoctorSessionChange(connection, {
            doctorSessionId: activeSession.doctor_session_id,
            doctorId: normalizedDoctorId,
            branchId: activeSession.branch_id,
            oldStatus: activeSession.session_status,
            newStatus: DOCTOR_SESSION_STATUS.OUT,
            action: SESSION_ACTION.PAUSE_SESSION,
            note,
            changedByUserId: actorUserId,
            changedByRole: actorRole,
            source: 'MANUAL',
            ipAddress,
            userAgent,
        });

        return {
            changed: true,
            payload: await getDoctorSessionStatus({
                doctorId: normalizedDoctorId,
                branchId: normalizedBranchId,
                connection,
            }),
            pausedQueueSessions,
        };
    });

    if (result.payload) {
        emitDoctorSessionUpdate(result.payload);
    }

    for (const queueSession of result.pausedQueueSessions || []) {
        await cancelScheduledAutoCallNext({
            branchId: queueSession.branchId,
            slotId: queueSession.slotId,
            appointmentDate: queueSession.appointmentDate,
        });

        await withTransaction(async (connection) => recalculateLiveRuntimeProjection(connection, {
            branchId: queueSession.branchId,
            slotId: queueSession.slotId,
            appointmentDate: queueSession.appointmentDate,
            actorUserId,
            actorIp: ipAddress,
        }));
    }

    return result;
};

module.exports = {
    DOCTOR_SESSION_STATUS,
    SESSION_ACTION,
    getClientMetadata,
    getDoctorSessionStatus,
    resolveDoctorSessionTargetDoctorId,
    resolveDoctorVisibleSlotId,
    getDoctorSessionLogs,
    startDoctorSession,
    takeDoctorBreak,
    resumeDoctorBreak,
    pauseDoctorSession,
};
