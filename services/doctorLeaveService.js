const { query, withTransaction } = require('../config/db');
const AppError = require('../utils/AppError');
const { getDoctorSessionStatus } = require('./doctorSessionService');

const LEAVE_STATUS = {
    ACTIVE: 'ACTIVE',
    CANCELLED: 'CANCELLED',
};

const toPositiveInt = (value) => {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) {
        return null;
    }

    return parsed;
};

const isValidDateString = (value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value || '').trim());
const isValidMonthString = (value) => /^\d{4}-\d{2}$/.test(String(value || '').trim());

const getExecutor = (connection = null) => async (sql, params = []) => {
    if (connection) {
        const [rows] = await connection.execute(sql, params);
        return rows;
    }

    return query(sql, params);
};

const getTodayDateString = (now = new Date()) => {
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
};

const getCurrentMonthString = (now = new Date()) => {
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    return `${year}-${month}`;
};

const getMonthBounds = (month) => {
    const normalizedMonth = String(month || '').trim();
    if (!isValidMonthString(normalizedMonth)) {
        throw new AppError('month must be in YYYY-MM format', 400);
    }

    const [yearStr, monthStr] = normalizedMonth.split('-');
    const year = Number(yearStr);
    const monthIndex = Number(monthStr) - 1;

    const monthStart = new Date(year, monthIndex, 1);
    const monthEnd = new Date(year, monthIndex + 1, 0);

    return {
        month: normalizedMonth,
        fromDate: getTodayDateString(monthStart),
        toDate: getTodayDateString(monthEnd),
    };
};

const getBranchActiveLeave = async ({ branchId, leaveDate, connection = null } = {}) => {
    const normalizedBranchId = toPositiveInt(branchId);
    const normalizedLeaveDate = String(leaveDate || '').trim();

    if (!normalizedBranchId) {
        throw new AppError('branch_id must be a positive integer', 400);
    }

    if (!isValidDateString(normalizedLeaveDate)) {
        throw new AppError('leave_date must be in YYYY-MM-DD format', 400);
    }

    const execute = getExecutor(connection);
    const rows = await execute(
        `SELECT
            l.id AS leave_id,
            l.doctor_id,
            l.fk_branch_id AS branch_id,
            DATE_FORMAT(l.leave_date, '%Y-%m-%d') AS leave_date,
            l.leave_reason,
            l.status,
            l.cancelled_at,
            l.cancelled_by_user_id,
            l.cancelled_by_role,
            l.created_at,
            l.updated_at,
            d.full_name AS doctor_name,
            b.branch_name
         FROM tbl_branch_doctor_leaves l
         JOIN master_users d ON d.id = l.doctor_id
         JOIN master_clinic_branches b ON b.id = l.fk_branch_id
         WHERE l.fk_branch_id = ?
           AND l.leave_date = ?
           AND l.status = ?
         LIMIT 1`,
        [normalizedBranchId, normalizedLeaveDate, LEAVE_STATUS.ACTIVE]
    );

    return rows[0] || null;
};

const getDoctorLeavesByMonth = async ({ doctorId, branchId, month = null, connection = null } = {}) => {
    const normalizedDoctorId = toPositiveInt(doctorId);
    const normalizedBranchId = toPositiveInt(branchId);

    if (!normalizedDoctorId) {
        throw new AppError('doctor_id must be a positive integer', 400);
    }

    if (!normalizedBranchId) {
        throw new AppError('branch_id must be a positive integer', 400);
    }

    const effectiveMonth = month ? String(month).trim() : getCurrentMonthString();
    const { month: normalizedMonth, fromDate, toDate } = getMonthBounds(effectiveMonth);
    const execute = getExecutor(connection);

    const rows = await execute(
        `SELECT
            l.id AS leave_id,
            l.doctor_id,
            l.fk_branch_id AS branch_id,
            DATE_FORMAT(l.leave_date, '%Y-%m-%d') AS leave_date,
            l.leave_reason,
            l.status,
            l.cancelled_at,
            l.cancelled_by_user_id,
            l.cancelled_by_role,
            l.created_at,
            l.updated_at,
            d.full_name AS doctor_name,
            b.branch_name
         FROM tbl_branch_doctor_leaves l
         JOIN master_users d ON d.id = l.doctor_id
         JOIN master_clinic_branches b ON b.id = l.fk_branch_id
         WHERE l.doctor_id = ?
           AND l.fk_branch_id = ?
           AND l.leave_date BETWEEN ? AND ?
           AND l.status = ?
         ORDER BY l.leave_date ASC, l.id ASC`,
        [normalizedDoctorId, normalizedBranchId, fromDate, toDate, LEAVE_STATUS.ACTIVE]
    );

    return {
        month: normalizedMonth,
        data: rows,
    };
};

const ensureActiveBranchExists = async (connection, branchId) => {
    const [branchRows] = await connection.execute(
        `SELECT id, branch_name
         FROM master_clinic_branches
         WHERE id = ?
           AND is_active = 1
         LIMIT 1`,
        [branchId]
    );

    if (branchRows.length === 0) {
        throw new AppError('Selected branch not found or inactive', 404);
    }

    return branchRows[0];
};

const normalizeLeaveDates = (leaveDates = []) => {
    if (!Array.isArray(leaveDates) || leaveDates.length === 0) {
        throw new AppError('leave_dates must be a non-empty array', 400);
    }

    const uniqueDates = Array.from(new Set(
        leaveDates
            .map((leaveDate) => String(leaveDate || '').trim())
            .filter(Boolean)
    ));

    if (uniqueDates.length === 0) {
        throw new AppError('leave_dates must include at least one valid date', 400);
    }

    uniqueDates.forEach((leaveDate) => {
        if (!isValidDateString(leaveDate)) {
            throw new AppError('Each leave_dates value must be in YYYY-MM-DD format', 400);
        }

        if (leaveDate < getTodayDateString()) {
            throw new AppError('leave_dates cannot include past dates', 400);
        }
    });

    return uniqueDates.sort();
};

const mapLeaveRowsByDate = (rows = []) => new Map(
    rows.map((row) => [String(row.leave_date), row])
);

const fetchLeavesByDates = async ({ connection, doctorId, branchId, leaveDates }) => {
    const placeholders = leaveDates.map(() => '?').join(', ');
    const [rows] = await connection.execute(
        `SELECT
            l.id AS leave_id,
            l.doctor_id,
            l.fk_branch_id AS branch_id,
            DATE_FORMAT(l.leave_date, '%Y-%m-%d') AS leave_date,
            l.leave_reason,
            l.status,
            l.cancelled_at,
            l.cancelled_by_user_id,
            l.cancelled_by_role,
            l.created_at,
            l.updated_at,
            d.full_name AS doctor_name,
            b.branch_name
         FROM tbl_branch_doctor_leaves l
         JOIN master_users d ON d.id = l.doctor_id
         JOIN master_clinic_branches b ON b.id = l.fk_branch_id
         WHERE l.doctor_id = ?
           AND l.fk_branch_id = ?
           AND l.leave_date IN (${placeholders})
         ORDER BY l.leave_date ASC, l.id ASC`,
        [doctorId, branchId, ...leaveDates]
    );

    return rows;
};

const createDoctorLeave = async ({
    doctorId,
    branchId,
    leaveDate,
    leaveReason = null,
    actorUserId,
    actorRole = null,
    actorIp = null,
}) => {
    const normalizedDoctorId = toPositiveInt(doctorId);
    const normalizedBranchId = toPositiveInt(branchId);
    const normalizedActorUserId = toPositiveInt(actorUserId);
    const normalizedLeaveDate = String(leaveDate || '').trim();
    const normalizedLeaveReason = leaveReason ? String(leaveReason).trim() : null;

    if (!normalizedDoctorId) {
        throw new AppError('doctor_id must be a positive integer', 400);
    }

    if (!normalizedBranchId) {
        throw new AppError('branch_id must be a positive integer', 400);
    }

    if (!normalizedActorUserId) {
        throw new AppError('actor_user_id must be a positive integer', 400);
    }

    if (!isValidDateString(normalizedLeaveDate)) {
        throw new AppError('leave_date must be in YYYY-MM-DD format', 400);
    }

    if (normalizedLeaveDate < getTodayDateString()) {
        throw new AppError('leave_date cannot be in the past', 400);
    }

    return withTransaction(async (connection) => {
        await ensureActiveBranchExists(connection, normalizedBranchId);

        const [existingRows] = await connection.execute(
            `SELECT
                id,
                status
             FROM tbl_branch_doctor_leaves
             WHERE doctor_id = ?
               AND fk_branch_id = ?
               AND leave_date = ?
             LIMIT 1
             FOR UPDATE`,
            [normalizedDoctorId, normalizedBranchId, normalizedLeaveDate]
        );

        let leaveId = null;

        if (existingRows.length > 0) {
            const existingLeave = existingRows[0];

            if (existingLeave.status === LEAVE_STATUS.ACTIVE) {
                throw new AppError('Leave is already marked for the selected branch and date', 409);
            }

            await connection.execute(
                `UPDATE tbl_branch_doctor_leaves
                 SET status = ?,
                     leave_reason = ?,
                     cancelled_at = NULL,
                     cancelled_by_user_id = NULL,
                     cancelled_by_role = NULL,
                     updated_by = ?,
                     updated_ip = ?
                 WHERE id = ?`,
                [
                    LEAVE_STATUS.ACTIVE,
                    normalizedLeaveReason,
                    normalizedActorUserId,
                    actorIp,
                    existingLeave.id,
                ]
            );

            leaveId = existingLeave.id;
        } else {
            const [insertResult] = await connection.execute(
                `INSERT INTO tbl_branch_doctor_leaves
                 (doctor_id, fk_branch_id, leave_date, leave_reason, status, created_by, updated_by, created_ip, updated_ip)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    normalizedDoctorId,
                    normalizedBranchId,
                    normalizedLeaveDate,
                    normalizedLeaveReason,
                    LEAVE_STATUS.ACTIVE,
                    normalizedActorUserId,
                    normalizedActorUserId,
                    actorIp,
                    actorIp,
                ]
            );

            leaveId = insertResult.insertId;
        }

        const [rows] = await connection.execute(
            `SELECT
                l.id AS leave_id,
                l.doctor_id,
                l.fk_branch_id AS branch_id,
                DATE_FORMAT(l.leave_date, '%Y-%m-%d') AS leave_date,
                l.leave_reason,
                l.status,
                l.cancelled_at,
                l.cancelled_by_user_id,
                l.cancelled_by_role,
                l.created_at,
                l.updated_at,
                d.full_name AS doctor_name,
                b.branch_name
             FROM tbl_branch_doctor_leaves l
             JOIN master_users d ON d.id = l.doctor_id
             JOIN master_clinic_branches b ON b.id = l.fk_branch_id
             WHERE l.id = ?
             LIMIT 1`,
            [leaveId]
        );

        return rows[0] || null;
    });
};

const cancelDoctorLeave = async ({
    leaveId,
    doctorId,
    actorUserId,
    actorRole = null,
    actorIp = null,
}) => {
    const normalizedLeaveId = toPositiveInt(leaveId);
    const normalizedDoctorId = toPositiveInt(doctorId);
    const normalizedActorUserId = toPositiveInt(actorUserId);

    if (!normalizedLeaveId) {
        throw new AppError('leave_id must be a positive integer', 400);
    }

    if (!normalizedDoctorId) {
        throw new AppError('doctor_id must be a positive integer', 400);
    }

    if (!normalizedActorUserId) {
        throw new AppError('actor_user_id must be a positive integer', 400);
    }

    return withTransaction(async (connection) => {
        const [rows] = await connection.execute(
            `SELECT
                id,
                doctor_id,
                fk_branch_id,
                status
             FROM tbl_branch_doctor_leaves
             WHERE id = ?
               AND doctor_id = ?
             LIMIT 1
             FOR UPDATE`,
            [normalizedLeaveId, normalizedDoctorId]
        );

        if (rows.length === 0) {
            throw new AppError('Doctor leave not found', 404);
        }

        if (rows[0].status === LEAVE_STATUS.CANCELLED) {
            throw new AppError('Doctor leave is already cancelled', 409);
        }

        await connection.execute(
            `UPDATE tbl_branch_doctor_leaves
             SET status = ?,
                 cancelled_at = NOW(),
                 cancelled_by_user_id = ?,
                 cancelled_by_role = ?,
                 updated_by = ?,
                 updated_ip = ?
             WHERE id = ?`,
            [
                LEAVE_STATUS.CANCELLED,
                normalizedActorUserId,
                actorRole,
                normalizedActorUserId,
                actorIp,
                normalizedLeaveId,
            ]
        );

        const [updatedRows] = await connection.execute(
            `SELECT
                l.id AS leave_id,
                l.doctor_id,
                l.fk_branch_id AS branch_id,
                DATE_FORMAT(l.leave_date, '%Y-%m-%d') AS leave_date,
                l.leave_reason,
                l.status,
                l.cancelled_at,
                l.cancelled_by_user_id,
                l.cancelled_by_role,
                l.created_at,
                l.updated_at,
                d.full_name AS doctor_name,
                b.branch_name
             FROM tbl_branch_doctor_leaves l
             JOIN master_users d ON d.id = l.doctor_id
             JOIN master_clinic_branches b ON b.id = l.fk_branch_id
             WHERE l.id = ?
             LIMIT 1`,
            [normalizedLeaveId]
        );

        return updatedRows[0] || null;
    });
};

const createDoctorLeavesBulk = async ({
    doctorId,
    branchId,
    leaveDates,
    leaveReason = null,
    actorUserId,
    actorIp = null,
}) => {
    const normalizedDoctorId = toPositiveInt(doctorId);
    const normalizedBranchId = toPositiveInt(branchId);
    const normalizedActorUserId = toPositiveInt(actorUserId);
    const normalizedLeaveReason = leaveReason ? String(leaveReason).trim() : null;
    const normalizedLeaveDates = normalizeLeaveDates(leaveDates);

    if (!normalizedDoctorId) {
        throw new AppError('doctor_id must be a positive integer', 400);
    }

    if (!normalizedBranchId) {
        throw new AppError('branch_id must be a positive integer', 400);
    }

    if (!normalizedActorUserId) {
        throw new AppError('actor_user_id must be a positive integer', 400);
    }

    return withTransaction(async (connection) => {
        await ensureActiveBranchExists(connection, normalizedBranchId);

        const placeholders = normalizedLeaveDates.map(() => '?').join(', ');
        const [existingRows] = await connection.execute(
            `SELECT
                id,
                DATE_FORMAT(leave_date, '%Y-%m-%d') AS leave_date,
                status
             FROM tbl_branch_doctor_leaves
             WHERE doctor_id = ?
               AND fk_branch_id = ?
               AND leave_date IN (${placeholders})
             FOR UPDATE`,
            [normalizedDoctorId, normalizedBranchId, ...normalizedLeaveDates]
        );

        const existingByDate = new Map(
            existingRows.map((row) => [String(row.leave_date), row])
        );

        const activatedDates = [];
        const skippedDates = [];

        for (const leaveDate of normalizedLeaveDates) {
            const existingLeave = existingByDate.get(leaveDate);

            if (existingLeave) {
                if (existingLeave.status === LEAVE_STATUS.ACTIVE) {
                    skippedDates.push(leaveDate);
                    continue;
                }

                await connection.execute(
                    `UPDATE tbl_branch_doctor_leaves
                     SET status = ?,
                         leave_reason = ?,
                         cancelled_at = NULL,
                         cancelled_by_user_id = NULL,
                         cancelled_by_role = NULL,
                         updated_by = ?,
                         updated_ip = ?
                     WHERE id = ?`,
                    [
                        LEAVE_STATUS.ACTIVE,
                        normalizedLeaveReason,
                        normalizedActorUserId,
                        actorIp,
                        existingLeave.id,
                    ]
                );
                activatedDates.push(leaveDate);
                continue;
            }

            await connection.execute(
                `INSERT INTO tbl_branch_doctor_leaves
                 (doctor_id, fk_branch_id, leave_date, leave_reason, status, created_by, updated_by, created_ip, updated_ip)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    normalizedDoctorId,
                    normalizedBranchId,
                    leaveDate,
                    normalizedLeaveReason,
                    LEAVE_STATUS.ACTIVE,
                    normalizedActorUserId,
                    normalizedActorUserId,
                    actorIp,
                    actorIp,
                ]
            );

            activatedDates.push(leaveDate);
        }

        const rows = await fetchLeavesByDates({
            connection,
            doctorId: normalizedDoctorId,
            branchId: normalizedBranchId,
            leaveDates: normalizedLeaveDates,
        });

        return {
            leaves: rows.filter((row) => row.status === LEAVE_STATUS.ACTIVE),
            activated_dates: activatedDates,
            skipped_dates: skippedDates,
        };
    });
};

const cancelDoctorLeavesBulk = async ({
    doctorId,
    branchId,
    leaveDates,
    actorUserId,
    actorRole = null,
    actorIp = null,
}) => {
    const normalizedDoctorId = toPositiveInt(doctorId);
    const normalizedBranchId = toPositiveInt(branchId);
    const normalizedActorUserId = toPositiveInt(actorUserId);
    const normalizedLeaveDates = normalizeLeaveDates(leaveDates);

    if (!normalizedDoctorId) {
        throw new AppError('doctor_id must be a positive integer', 400);
    }

    if (!normalizedBranchId) {
        throw new AppError('branch_id must be a positive integer', 400);
    }

    if (!normalizedActorUserId) {
        throw new AppError('actor_user_id must be a positive integer', 400);
    }

    return withTransaction(async (connection) => {
        await ensureActiveBranchExists(connection, normalizedBranchId);

        const placeholders = normalizedLeaveDates.map(() => '?').join(', ');
        const [rows] = await connection.execute(
            `SELECT
                id,
                DATE_FORMAT(leave_date, '%Y-%m-%d') AS leave_date,
                status
             FROM tbl_branch_doctor_leaves
             WHERE doctor_id = ?
               AND fk_branch_id = ?
               AND leave_date IN (${placeholders})
             FOR UPDATE`,
            [normalizedDoctorId, normalizedBranchId, ...normalizedLeaveDates]
        );

        const rowsByDate = new Map(rows.map((row) => [String(row.leave_date), row]));
        const cancelledDates = [];
        const skippedDates = [];

        for (const leaveDate of normalizedLeaveDates) {
            const leaveRow = rowsByDate.get(leaveDate);

            if (!leaveRow || leaveRow.status === LEAVE_STATUS.CANCELLED) {
                skippedDates.push(leaveDate);
                continue;
            }

            await connection.execute(
                `UPDATE tbl_branch_doctor_leaves
                 SET status = ?,
                     cancelled_at = NOW(),
                     cancelled_by_user_id = ?,
                     cancelled_by_role = ?,
                     updated_by = ?,
                     updated_ip = ?
                 WHERE id = ?`,
                [
                    LEAVE_STATUS.CANCELLED,
                    normalizedActorUserId,
                    actorRole,
                    normalizedActorUserId,
                    actorIp,
                    leaveRow.id,
                ]
            );

            cancelledDates.push(leaveDate);
        }

        const updatedRows = await fetchLeavesByDates({
            connection,
            doctorId: normalizedDoctorId,
            branchId: normalizedBranchId,
            leaveDates: normalizedLeaveDates,
        });

        return {
            leaves: updatedRows,
            cancelled_dates: cancelledDates,
            skipped_dates: skippedDates,
        };
    });
};

const getBranchDoctorAvailability = async ({ branchId, appointmentDate, connection = null } = {}) => {
    const normalizedBranchId = toPositiveInt(branchId);
    const normalizedAppointmentDate = String(appointmentDate || '').trim();

    if (!normalizedBranchId) {
        throw new AppError('branch_id must be a positive integer', 400);
    }

    if (!isValidDateString(normalizedAppointmentDate)) {
        throw new AppError('appointment_date must be in YYYY-MM-DD format', 400);
    }

    const execute = getExecutor(connection);
    const [activeLeave, slotTimeOverrides] = await Promise.all([
        getBranchActiveLeave({
            branchId: normalizedBranchId,
            leaveDate: normalizedAppointmentDate,
            connection,
        }),
        execute(
            `SELECT id, fk_slot_id, override_start_time, override_end_time, default_start_time, default_end_time
             FROM tbl_doctor_slot_time_overrides
             WHERE fk_branch_id = ?
               AND appointment_date = ?
               AND status = 'ACTIVE'`,
            [normalizedBranchId, normalizedAppointmentDate]
        )
    ]);

    if (activeLeave) {
        return {
            branch_id: normalizedBranchId,
            appointment_date: normalizedAppointmentDate,
            booking_enabled: false,
            reason: 'Doctor is not available in clinic',
            source: 'LEAVE',
            leave: activeLeave,
            live_status: null,
            slot_time_overrides: slotTimeOverrides,
        };
    }

    if (normalizedAppointmentDate === getTodayDateString()) {
        const liveStatus = await getDoctorSessionStatus({
            branchId: normalizedBranchId,
            connection,
        });

        return {
            branch_id: normalizedBranchId,
            appointment_date: normalizedAppointmentDate,
            booking_enabled: true,
            reason: null,
            source: 'LIVE_SESSION',
            leave: null,
            live_status: liveStatus,
            slot_time_overrides: slotTimeOverrides,
        };
    }

    return {
        branch_id: normalizedBranchId,
        appointment_date: normalizedAppointmentDate,
        booking_enabled: true,
        reason: null,
        source: 'SCHEDULE',
        leave: null,
        live_status: null,
        slot_time_overrides: slotTimeOverrides,
    };
};

const assertBranchDoctorAvailableForBooking = async ({ branchId, appointmentDate, connection = null } = {}) => {
    const availability = await getBranchDoctorAvailability({
        branchId,
        appointmentDate,
        connection,
    });

    if (!availability.booking_enabled) {
        throw new AppError(availability.reason || 'Doctor is not available in clinic', 409, {
            availability,
        });
    }

    return availability;
};

module.exports = {
    LEAVE_STATUS,
    isValidDateString,
    getCurrentMonthString,
    getDoctorLeavesByMonth,
    createDoctorLeave,
    createDoctorLeavesBulk,
    cancelDoctorLeave,
    cancelDoctorLeavesBulk,
    getBranchDoctorAvailability,
    assertBranchDoctorAvailableForBooking,
};
