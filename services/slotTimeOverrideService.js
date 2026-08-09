const AppError = require('../utils/AppError');

const DAY_SECONDS = 24 * 60 * 60;

const executeRows = async (executor, sql, params = []) => {
    if (typeof executor === 'function') {
        return executor(sql, params);
    }

    const [rows] = await executor.execute(sql, params);
    return rows;
};

const parseTimeToSeconds = (value) => {
    const match = String(value || '').trim().match(/^(\d{2}):(\d{2})(?::(\d{2}))?$/);
    if (!match) {
        return null;
    }

    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    const seconds = Number(match[3] || 0);
    if (hours > 23 || minutes > 59 || seconds > 59) {
        return null;
    }

    return (hours * 3600) + (minutes * 60) + seconds;
};

const formatSecondsToTime = (value) => {
    const seconds = Math.round(Number(value));
    if (!Number.isFinite(seconds) || seconds < 0 || seconds >= DAY_SECONDS) {
        return null;
    }

    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const remainingSeconds = seconds % 60;
    return [hours, minutes, remainingSeconds]
        .map((part) => String(part).padStart(2, '0'))
        .join(':');
};

const isFridayDate = (dateStr) => {
    if (!dateStr || typeof dateStr !== 'string') return false;
    const match = dateStr.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return false;
    const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    return date.getDay() === 5;
};

const resolveEffectiveSlotTiming = async ({
    executor,
    branchId,
    slotId,
    appointmentDate,
    lock = false,
}) => {
    const rows = await executeRows(
        executor,
        `SELECT
            s.id AS slot_id,
            s.fk_branch_id AS branch_id,
            s.slot_name,
            s.start_time AS default_start_time,
            s.end_time AS default_end_time,
            COALESCE(o.override_start_time, s.start_time) AS effective_start_time,
            COALESCE(o.override_end_time, s.end_time) AS effective_end_time,
            o.id AS override_id,
            o.reason,
            CASE WHEN o.id IS NULL THEN 0 ELSE 1 END AS has_override,
            (
                SELECT MIN(min_s.id)
                FROM master_slots min_s
                WHERE min_s.fk_branch_id = s.fk_branch_id
                  AND min_s.is_active = 1
            ) AS first_slot_id
         FROM master_slots s
         LEFT JOIN tbl_doctor_slot_time_overrides o
           ON o.fk_branch_id = s.fk_branch_id
          AND o.fk_slot_id = s.id
          AND o.appointment_date = ?
          AND o.status = 'ACTIVE'
         WHERE s.id = ?
           AND s.fk_branch_id = ?
           AND s.is_active = 1
         LIMIT 1${lock ? ' FOR UPDATE' : ''}`,
        [appointmentDate, slotId, branchId]
    );

    if (rows.length === 0) {
        throw new AppError('Selected slot not found for the selected branch', 404);
    }

    const row = rows[0];
    let effectiveStart = String(row.effective_start_time);
    let effectiveEnd = String(row.effective_end_time);
    let hasOverride = Boolean(Number(row.has_override));
    let reason = row.reason || null;

    // Apply Friday schedule rule for Branch 2 (Devendra Nagar / Pandri Branch): first slot starts at 3:00 PM (15:00:00)
    const isFriday = isFridayDate(appointmentDate);
    const isBranch2 = Number(row.branch_id) === 2;
    const isFirstSlot = Number(row.slot_id) === Number(row.first_slot_id);

    if (isFriday && isBranch2 && isFirstSlot && !hasOverride) {
        const fridayStartTime = '15:00:00';
        if (effectiveStart < fridayStartTime) {
            const shift = calculateShiftedTiming({
                defaultStartTime: String(row.default_start_time),
                defaultEndTime: String(row.default_end_time),
                overrideStartTime: fridayStartTime,
            });
            effectiveStart = shift.overrideStartTime;
            effectiveEnd = shift.overrideEndTime;
            hasOverride = true;
            reason = 'Devendra Nagar (Pandri Branch) Friday recurring schedule: first slot starts at 3:00 PM';
        }
    }

    return {
        slotId: Number(row.slot_id),
        branchId: Number(row.branch_id),
        slotName: row.slot_name,
        defaultStartTime: String(row.default_start_time),
        defaultEndTime: String(row.default_end_time),
        effectiveStartTime: effectiveStart,
        effectiveEndTime: effectiveEnd,
        overrideId: row.override_id ? Number(row.override_id) : null,
        hasOverride,
        reason,
    };
};

const calculateShiftedTiming = ({ defaultStartTime, defaultEndTime, overrideStartTime }) => {
    const defaultStartSeconds = parseTimeToSeconds(defaultStartTime);
    const defaultEndSeconds = parseTimeToSeconds(defaultEndTime);
    const overrideStartSeconds = parseTimeToSeconds(overrideStartTime);

    if (defaultStartSeconds === null || defaultEndSeconds === null || overrideStartSeconds === null) {
        throw new AppError('Slot timing must be a valid HH:mm or HH:mm:ss value', 400);
    }

    const durationSeconds = defaultEndSeconds - defaultStartSeconds;
    if (durationSeconds <= 0) {
        throw new AppError('Overnight slot timing is not supported', 409);
    }

    const overrideEndSeconds = overrideStartSeconds + durationSeconds;
    if (overrideEndSeconds >= DAY_SECONDS) {
        throw new AppError('Shifted slot cannot end after midnight', 400);
    }

    return {
        overrideStartTime: formatSecondsToTime(overrideStartSeconds),
        overrideEndTime: formatSecondsToTime(overrideEndSeconds),
        durationSeconds,
        shiftSeconds: overrideStartSeconds - defaultStartSeconds,
    };
};

const shiftActiveExtensionTokenTimes = async ({
    connection,
    branchId,
    slotId,
    appointmentDate,
    deltaSeconds,
}) => {
    if (!deltaSeconds) {
        return 0;
    }

    const [rows] = await connection.execute(
        `SELECT st.id, st.estimated_start_time, st.estimated_end_time
         FROM tbl_slot_extension_tokens st
         JOIN tbl_slot_token_extensions e ON e.id = st.fk_extension_id
         WHERE e.fk_branch_id = ?
           AND e.fk_slot_id = ?
           AND e.appointment_date = ?
           AND e.status = 'ACTIVE'
         FOR UPDATE`,
        [branchId, slotId, appointmentDate]
    );

    for (const row of rows) {
        const startSeconds = parseTimeToSeconds(row.estimated_start_time);
        const endSeconds = parseTimeToSeconds(row.estimated_end_time);
        const shiftedStart = formatSecondsToTime(startSeconds + deltaSeconds);
        const shiftedEnd = formatSecondsToTime(endSeconds + deltaSeconds);
        if (!shiftedStart || !shiftedEnd) {
            throw new AppError('Shifted extra-token timing cannot cross midnight', 409);
        }

        await connection.execute(
            `UPDATE tbl_slot_extension_tokens
             SET estimated_start_time = ?, estimated_end_time = ?
             WHERE id = ?`,
            [shiftedStart, shiftedEnd, row.id]
        );
    }

    return rows.length;
};

module.exports = {
    calculateShiftedTiming,
    parseTimeToSeconds,
    resolveEffectiveSlotTiming,
    shiftActiveExtensionTokenTimes,
};
