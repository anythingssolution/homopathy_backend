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

// Weekly (recurring) schedule rules live in tbl_branch_recurring_schedule_rules and are
// materialised into tbl_doctor_slot_time_overrides as regular override rows, so every SQL
// query that already understands doctor overrides picks them up with no extra work.
// Auto-created rows are tagged with this reason prefix so they can be told apart from
// rows the doctor created or edited by hand.
const RECURRING_RULE_REASON_PREFIX = '[WEEKLY RULE]';
const SYSTEM_ACTOR_USER_ID = 0;

// Matches the table comment: 1=Sunday ... 7=Saturday (same as MySQL DAYOFWEEK()).
const DAY_OF_WEEK_LABELS = ['', 'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const getDayOfWeekForDate = (dateStr) => {
    if (!dateStr || typeof dateStr !== 'string') return null;
    const match = dateStr.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return null;
    const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    return Number.isNaN(date.getTime()) ? null : date.getDay() + 1;
};

const isRecurringRuleReason = (reason) => String(reason || '').startsWith(RECURRING_RULE_REASON_PREFIX);

const buildRecurringRuleReason = (rule) => {
    const description = String(rule?.rule_description || '').trim();
    const dayLabel = DAY_OF_WEEK_LABELS[Number(rule?.day_of_week)] || 'Weekly';
    return `${RECURRING_RULE_REASON_PREFIX} ${description || `${dayLabel} schedule`}`.slice(0, 500);
};

const getFirstActiveSlotId = async ({ executor, branchId }) => {
    const rows = await executeRows(
        executor,
        `SELECT id
         FROM master_slots
         WHERE fk_branch_id = ?
           AND is_active = 1
         ORDER BY start_time ASC, id ASC
         LIMIT 1`,
        [branchId]
    );
    return rows[0] ? Number(rows[0].id) : null;
};

/**
 * Finds the active weekly rule that applies to a slot on a given date.
 * A rule bound to the specific slot wins over a branch-wide "first slot" rule (fk_slot_id NULL).
 */
const findRecurringRuleForSlot = async ({ executor, branchId, slotId, appointmentDate }) => {
    const dayOfWeek = getDayOfWeekForDate(appointmentDate);
    if (!dayOfWeek || !branchId || !slotId) {
        return null;
    }

    const rows = await executeRows(
        executor,
        `SELECT id, fk_branch_id, fk_slot_id, day_of_week, override_start_time, rule_description
         FROM tbl_branch_recurring_schedule_rules
         WHERE fk_branch_id = ?
           AND day_of_week = ?
           AND is_active = 1
           AND (fk_slot_id = ? OR fk_slot_id IS NULL)
         ORDER BY (fk_slot_id IS NULL) ASC, id DESC`,
        [branchId, dayOfWeek, slotId]
    );

    if (rows.length === 0) {
        return null;
    }

    const specific = rows.find((row) => row.fk_slot_id !== null && Number(row.fk_slot_id) === Number(slotId));
    if (specific) {
        return specific;
    }

    const firstSlotId = await getFirstActiveSlotId({ executor, branchId });
    if (firstSlotId !== Number(slotId)) {
        return null;
    }

    return rows.find((row) => row.fk_slot_id === null) || null;
};

/**
 * Creates the override row for a weekly rule on a specific date if nothing exists yet.
 * Never touches an existing row (ACTIVE or CANCELLED) — a doctor's own decision always wins.
 */
const ensureRecurringSlotOverride = async ({
    executor,
    branchId,
    slotId,
    appointmentDate,
    defaultStartTime,
    defaultEndTime,
}) => {
    const rule = await findRecurringRuleForSlot({ executor, branchId, slotId, appointmentDate });
    if (!rule) {
        return { applied: false, rule: null, override: null };
    }

    const existingRows = await executeRows(
        executor,
        `SELECT id, status
         FROM tbl_doctor_slot_time_overrides
         WHERE fk_branch_id = ? AND fk_slot_id = ? AND appointment_date = ?
         LIMIT 1`,
        [branchId, slotId, appointmentDate]
    );

    if (existingRows.length > 0) {
        return { applied: false, rule, override: null };
    }

    let shifted;
    try {
        shifted = calculateShiftedTiming({
            defaultStartTime,
            defaultEndTime,
            overrideStartTime: String(rule.override_start_time),
        });
    } catch (error) {
        // A rule that cannot be applied to this slot (e.g. would cross midnight) must never
        // block booking or queue operations — fall back to the default timing.
        console.error(`Weekly schedule rule ${rule.id} skipped for slot ${slotId} on ${appointmentDate}:`, error.message);
        return { applied: false, rule, override: null };
    }

    if (shifted.shiftSeconds === 0) {
        return { applied: false, rule, override: null };
    }

    const reason = buildRecurringRuleReason(rule);
    const insertRows = await executeRows(
        executor,
        `INSERT IGNORE INTO tbl_doctor_slot_time_overrides
         (fk_branch_id, fk_slot_id, appointment_date, default_start_time, default_end_time,
          override_start_time, override_end_time, shift_seconds, reason, status, created_by, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?)`,
        [
            branchId, slotId, appointmentDate,
            defaultStartTime, defaultEndTime,
            shifted.overrideStartTime, shifted.overrideEndTime, shifted.shiftSeconds,
            reason, SYSTEM_ACTOR_USER_ID, SYSTEM_ACTOR_USER_ID,
        ]
    );

    const insertId = Number(insertRows?.insertId) || null;
    if (!insertId) {
        // Lost a race with another request that inserted the same row — treat as already present.
        return { applied: false, rule, override: null };
    }

    return {
        applied: true,
        rule,
        override: {
            id: insertId,
            reason,
            overrideStartTime: shifted.overrideStartTime,
            overrideEndTime: shifted.overrideEndTime,
            shiftSeconds: shifted.shiftSeconds,
        },
    };
};

/**
 * Materialises weekly rules for every active slot of a branch on one date.
 * Cheap no-op when the branch has no rule for that weekday.
 */
const materializeRecurringOverridesForBranchDate = async ({ executor, branchId, appointmentDate }) => {
    const dayOfWeek = getDayOfWeekForDate(appointmentDate);
    if (!dayOfWeek || !branchId) {
        return 0;
    }

    const ruleRows = await executeRows(
        executor,
        `SELECT 1
         FROM tbl_branch_recurring_schedule_rules
         WHERE fk_branch_id = ? AND day_of_week = ? AND is_active = 1
         LIMIT 1`,
        [branchId, dayOfWeek]
    );
    if (ruleRows.length === 0) {
        return 0;
    }

    const slots = await executeRows(
        executor,
        `SELECT id, start_time, end_time
         FROM master_slots
         WHERE fk_branch_id = ? AND is_active = 1
         ORDER BY start_time ASC, id ASC`,
        [branchId]
    );

    let applied = 0;
    for (const slot of slots) {
        const ensured = await ensureRecurringSlotOverride({
            executor,
            branchId: Number(branchId),
            slotId: Number(slot.id),
            appointmentDate,
            defaultStartTime: String(slot.start_time),
            defaultEndTime: String(slot.end_time),
        });
        if (ensured.applied) {
            applied += 1;
        }
    }
    return applied;
};

const resolveEffectiveSlotTiming = async ({
    executor,
    branchId,
    slotId,
    appointmentDate,
    lock = false,
    // Set to false by callers that are about to write the override themselves and need the raw state.
    materializeRule = true,
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
            CASE WHEN o.id IS NULL THEN 0 ELSE 1 END AS has_override
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
    let overrideId = row.override_id ? Number(row.override_id) : null;
    let recurringRule = null;

    if (!hasOverride && materializeRule) {
        // No override for this date yet: materialise the weekly rule (if one applies) so that
        // booking, live queue and every list query see the same effective time.
        const ensured = await ensureRecurringSlotOverride({
            executor,
            branchId: Number(row.branch_id),
            slotId: Number(row.slot_id),
            appointmentDate,
            defaultStartTime: String(row.default_start_time),
            defaultEndTime: String(row.default_end_time),
        });
        recurringRule = ensured.rule;

        if (ensured.applied) {
            effectiveStart = ensured.override.overrideStartTime;
            effectiveEnd = ensured.override.overrideEndTime;
            hasOverride = true;
            reason = ensured.override.reason;
            overrideId = ensured.override.id;
        }
    } else {
        recurringRule = await findRecurringRuleForSlot({
            executor,
            branchId: Number(row.branch_id),
            slotId: Number(row.slot_id),
            appointmentDate,
        });
    }

    return {
        slotId: Number(row.slot_id),
        branchId: Number(row.branch_id),
        slotName: row.slot_name,
        defaultStartTime: String(row.default_start_time),
        defaultEndTime: String(row.default_end_time),
        effectiveStartTime: effectiveStart,
        effectiveEndTime: effectiveEnd,
        overrideId,
        hasOverride,
        reason,
        isRecurringRule: hasOverride && isRecurringRuleReason(reason),
        recurringRule: recurringRule
            ? {
                id: Number(recurringRule.id),
                slotId: recurringRule.fk_slot_id === null ? null : Number(recurringRule.fk_slot_id),
                dayOfWeek: Number(recurringRule.day_of_week),
                dayLabel: DAY_OF_WEEK_LABELS[Number(recurringRule.day_of_week)] || null,
                startTime: String(recurringRule.override_start_time),
                description: recurringRule.rule_description || null,
            }
            : null,
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
    DAY_OF_WEEK_LABELS,
    RECURRING_RULE_REASON_PREFIX,
    SYSTEM_ACTOR_USER_ID,
    buildRecurringRuleReason,
    calculateShiftedTiming,
    ensureRecurringSlotOverride,
    findRecurringRuleForSlot,
    formatSecondsToTime,
    getDayOfWeekForDate,
    getFirstActiveSlotId,
    isRecurringRuleReason,
    materializeRecurringOverridesForBranchDate,
    parseTimeToSeconds,
    resolveEffectiveSlotTiming,
    shiftActiveExtensionTokenTimes,
};
