const { query, withTransaction } = require('../config/db');
const AppError = require('../utils/AppError');
const {
    DAY_OF_WEEK_LABELS,
    SYSTEM_ACTOR_USER_ID,
    buildRecurringRuleReason,
    calculateShiftedTiming,
    getDayOfWeekForDate,
    getFirstActiveSlotId,
    isRecurringRuleReason,
    resolveEffectiveSlotTiming,
    shiftActiveExtensionTokenTimes,
} = require('./slotTimeOverrideService');
const { emitLiveQueueEvent, recalculateQueuePlan } = require('./liveQueueService');

const DEFAULT_WEEKS_AHEAD = 8;
const MATERIALIZER_INTERVAL_MS = 6 * 60 * 60 * 1000;
const MATERIALIZER_STARTUP_DELAY_MS = 15 * 1000;

const toPositiveInt = (value) => {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

const pad = (value) => String(value).padStart(2, '0');

const formatLocalDate = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

const getToday = () => formatLocalDate(new Date());

const normalizeTimeInput = (value) => {
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
    return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
};

/** All dates from today onwards (inclusive) within `weeksAhead` weeks that fall on `dayOfWeek` (1=Sunday..7=Saturday). */
const listUpcomingDatesForDay = (dayOfWeek, weeksAhead = DEFAULT_WEEKS_AHEAD) => {
    const dates = [];
    const cursor = new Date();
    cursor.setHours(0, 0, 0, 0);
    const totalDays = Math.max(1, Number(weeksAhead) || DEFAULT_WEEKS_AHEAD) * 7;

    for (let offset = 0; offset < totalDays; offset += 1) {
        if (cursor.getDay() + 1 === Number(dayOfWeek)) {
            dates.push(formatLocalDate(cursor));
        }
        cursor.setDate(cursor.getDate() + 1);
    }

    return dates;
};

const assertSlotTimingCanShift = async (connection, { branchId, slotId, appointmentDate }) => {
    const [sessionRows] = await connection.execute(
        `SELECT session_status
         FROM tbl_live_queue_sessions
         WHERE fk_branch_id = ? AND fk_slot_id = ? AND appointment_date = ?
         LIMIT 1 FOR UPDATE`,
        [branchId, slotId, appointmentDate]
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
        [branchId, slotId, appointmentDate]
    );
    if (startedRows.length > 0) {
        throw new AppError('Slot timing cannot be changed after patient check-in or consultation activity', 409);
    }
};

const countActiveAppointments = async (connection, { branchId, slotId, appointmentDate }) => {
    const [rows] = await connection.execute(
        `SELECT COUNT(*) AS total
         FROM tbl_appointments
         WHERE fk_branch_id = ? AND fk_slot_id = ? AND appointment_date = ?
           AND is_active = 1`,
        [branchId, slotId, appointmentDate]
    );
    return Number(rows[0]?.total || 0);
};

const writeOverrideAudit = async (connection, {
    overrideId,
    branchId,
    slotId,
    appointmentDate,
    action,
    oldData,
    newData,
    affectedAppointments,
    affectedExtensionTokens,
    actorUserId,
    ip,
}) => {
    await connection.execute(
        `INSERT INTO tbl_doctor_slot_time_override_audit_logs
         (fk_override_id, fk_branch_id, fk_slot_id, appointment_date, action,
          old_data_json, new_data_json, affected_appointments,
          affected_extension_tokens, performed_by, ip_address)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            overrideId, branchId, slotId, appointmentDate, action,
            JSON.stringify(oldData), JSON.stringify(newData),
            affectedAppointments, affectedExtensionTokens,
            actorUserId ?? SYSTEM_ACTOR_USER_ID, ip || null,
        ]
    );
};

/**
 * Moves a slot on one date to `overrideStartTime` (same duration), shifting any extra tokens
 * and re-planning the queue — the same steps the doctor's "Apply Shift" performs.
 * Must run inside a transaction. Returns null when the slot already sits at that time.
 */
const shiftSlotOverrideForDate = async (connection, {
    branchId,
    slotId,
    appointmentDate,
    overrideStartTime,
    reason,
    actorUserId,
    ip = null,
    action = 'UPSERT',
}) => {
    await assertSlotTimingCanShift(connection, { branchId, slotId, appointmentDate });
    const current = await resolveEffectiveSlotTiming({
        executor: connection, branchId, slotId, appointmentDate, lock: true, materializeRule: false,
    });
    const shifted = calculateShiftedTiming({
        defaultStartTime: current.defaultStartTime,
        defaultEndTime: current.defaultEndTime,
        overrideStartTime,
    });
    const previousShift = current.hasOverride
        ? calculateShiftedTiming({
            defaultStartTime: current.defaultStartTime,
            defaultEndTime: current.defaultEndTime,
            overrideStartTime: current.effectiveStartTime,
        }).shiftSeconds
        : 0;
    const deltaSeconds = shifted.shiftSeconds - previousShift;

    if (deltaSeconds === 0 && current.hasOverride && current.reason === reason) {
        return null;
    }

    const actor = actorUserId ?? SYSTEM_ACTOR_USER_ID;
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
            branchId, slotId, appointmentDate,
            current.defaultStartTime, current.defaultEndTime,
            shifted.overrideStartTime, shifted.overrideEndTime, shifted.shiftSeconds,
            reason, actor, actor,
        ]
    );
    const overrideId = current.overrideId || upsert.insertId;
    const affectedExtensionTokens = await shiftActiveExtensionTokenTimes({
        connection, branchId, slotId, appointmentDate, deltaSeconds,
    });
    const affectedAppointments = await countActiveAppointments(connection, { branchId, slotId, appointmentDate });

    await recalculateQueuePlan(connection, {
        branchId, slotId, appointmentDate, actorUserId: actor,
    });
    await writeOverrideAudit(connection, {
        overrideId, branchId, slotId, appointmentDate, action,
        oldData: current, newData: shifted,
        affectedAppointments, affectedExtensionTokens,
        actorUserId: actor, ip,
    });

    return {
        overrideId,
        ...shifted,
        deltaSeconds,
        affectedAppointments,
        affectedExtensionTokens,
    };
};

/** Cancels the override on one date so the slot returns to its default time. Must run inside a transaction. */
const cancelSlotOverrideForDate = async (connection, {
    branchId,
    slotId,
    appointmentDate,
    actorUserId,
    ip = null,
    action = 'RESET',
}) => {
    await assertSlotTimingCanShift(connection, { branchId, slotId, appointmentDate });
    const current = await resolveEffectiveSlotTiming({
        executor: connection, branchId, slotId, appointmentDate, lock: true, materializeRule: false,
    });
    if (!current.hasOverride || !current.overrideId) {
        return null;
    }

    const actor = actorUserId ?? SYSTEM_ACTOR_USER_ID;
    const currentShift = calculateShiftedTiming({
        defaultStartTime: current.defaultStartTime,
        defaultEndTime: current.defaultEndTime,
        overrideStartTime: current.effectiveStartTime,
    }).shiftSeconds;
    const affectedExtensionTokens = await shiftActiveExtensionTokenTimes({
        connection, branchId, slotId, appointmentDate, deltaSeconds: -currentShift,
    });
    await connection.execute(
        `UPDATE tbl_doctor_slot_time_overrides
         SET status = 'CANCELLED', cancelled_by = ?, cancelled_at = NOW(), updated_by = ?
         WHERE id = ?`,
        [actor, actor, current.overrideId]
    );
    const affectedAppointments = await countActiveAppointments(connection, { branchId, slotId, appointmentDate });
    await recalculateQueuePlan(connection, {
        branchId, slotId, appointmentDate, actorUserId: actor,
    });
    await writeOverrideAudit(connection, {
        overrideId: current.overrideId, branchId, slotId, appointmentDate, action,
        oldData: current,
        newData: {
            effective_start_time: current.defaultStartTime,
            effective_end_time: current.defaultEndTime,
        },
        affectedAppointments, affectedExtensionTokens,
        actorUserId: actor, ip,
    });

    return { overrideId: current.overrideId, affectedAppointments, affectedExtensionTokens };
};

const emitTimingUpdated = async ({ branchId, slotId, appointmentDate, reason }) => {
    try {
        await emitLiveQueueEvent({
            branchId, slotId, appointmentDate,
            eventName: 'slot-timing-updated',
            reason,
        });
    } catch (error) {
        console.error('Failed to emit slot-timing-updated event:', error.message);
    }
};

// ---------------------------------------------------------------------------
// Rule CRUD
// ---------------------------------------------------------------------------

const ruleSelectSql = `
    SELECT r.id, r.fk_branch_id, r.fk_slot_id, r.day_of_week, r.override_start_time,
           r.rule_description, r.is_active, r.created_at, r.updated_at,
           s.slot_name, s.start_time AS slot_start_time, s.end_time AS slot_end_time
    FROM tbl_branch_recurring_schedule_rules r
    LEFT JOIN master_slots s ON s.id = r.fk_slot_id
`;

const listBranchSlots = async (branchId) => {
    const rows = await query(
        `SELECT id, slot_name, start_time, end_time
         FROM master_slots
         WHERE fk_branch_id = ? AND is_active = 1
         ORDER BY start_time ASC, id ASC`,
        [branchId]
    );
    return rows.map((row) => ({
        slot_id: Number(row.id),
        slot_name: row.slot_name,
        start_time: String(row.start_time),
        end_time: String(row.end_time),
    }));
};

const formatRule = (row, slots = []) => {
    const firstSlot = slots[0] || null;
    const targetSlot = row.fk_slot_id === null
        ? firstSlot
        : {
            slot_id: Number(row.fk_slot_id),
            slot_name: row.slot_name,
            start_time: row.slot_start_time ? String(row.slot_start_time) : null,
            end_time: row.slot_end_time ? String(row.slot_end_time) : null,
        };

    let endTime = null;
    if (targetSlot?.start_time && targetSlot?.end_time) {
        try {
            endTime = calculateShiftedTiming({
                defaultStartTime: targetSlot.start_time,
                defaultEndTime: targetSlot.end_time,
                overrideStartTime: String(row.override_start_time),
            }).overrideEndTime;
        } catch (error) {
            endTime = null;
        }
    }

    return {
        id: Number(row.id),
        branch_id: Number(row.fk_branch_id),
        slot_id: row.fk_slot_id === null ? null : Number(row.fk_slot_id),
        applies_to_first_slot: row.fk_slot_id === null,
        slot_name: targetSlot?.slot_name || null,
        slot_default_start_time: targetSlot?.start_time || null,
        slot_default_end_time: targetSlot?.end_time || null,
        day_of_week: Number(row.day_of_week),
        day_label: DAY_OF_WEEK_LABELS[Number(row.day_of_week)] || null,
        start_time: String(row.override_start_time),
        end_time: endTime,
        description: row.rule_description || null,
        is_active: Boolean(Number(row.is_active)),
        created_at: row.created_at,
        updated_at: row.updated_at,
    };
};

const listRecurringRules = async ({ branchId, includeInactive = false }) => {
    const slots = await listBranchSlots(branchId);
    const rows = await query(
        `${ruleSelectSql}
         WHERE r.fk_branch_id = ?${includeInactive ? '' : ' AND r.is_active = 1'}
         ORDER BY r.day_of_week ASC, (r.fk_slot_id IS NULL) DESC, r.override_start_time ASC, r.id ASC`,
        [branchId]
    );
    return {
        rules: rows.map((row) => formatRule(row, slots)),
        slots,
    };
};

const getRecurringRuleById = async (ruleId, executor = query) => {
    const rows = typeof executor === 'function'
        ? await executor(`${ruleSelectSql} WHERE r.id = ? LIMIT 1`, [ruleId])
        : (await executor.execute(`${ruleSelectSql} WHERE r.id = ? LIMIT 1`, [ruleId]))[0];
    return rows[0] || null;
};

const validateRuleInput = async ({ branchId, slotId, dayOfWeek, startTime }) => {
    const normalizedDay = Number(dayOfWeek);
    if (!Number.isInteger(normalizedDay) || normalizedDay < 1 || normalizedDay > 7) {
        throw new AppError('day_of_week must be between 1 (Sunday) and 7 (Saturday)', 400);
    }

    const normalizedTime = normalizeTimeInput(startTime);
    if (!normalizedTime) {
        throw new AppError('start_time must be a valid HH:mm value', 400);
    }

    const slots = await listBranchSlots(branchId);
    if (slots.length === 0) {
        throw new AppError('No active slot is available for the selected branch', 404);
    }

    let targetSlot = slots[0];
    if (slotId !== null) {
        targetSlot = slots.find((slot) => slot.slot_id === Number(slotId)) || null;
        if (!targetSlot) {
            throw new AppError('Selected slot does not belong to the selected branch', 400);
        }
    }

    // Throws a descriptive 400/409 when the shift is impossible (e.g. would cross midnight).
    calculateShiftedTiming({
        defaultStartTime: targetSlot.start_time,
        defaultEndTime: targetSlot.end_time,
        overrideStartTime: normalizedTime,
    });

    return { dayOfWeek: normalizedDay, startTime: normalizedTime, targetSlot, slots };
};

const assertNoDuplicateRule = async ({ branchId, slotId, dayOfWeek, excludeRuleId = null }) => {
    const rows = await query(
        `SELECT id
         FROM tbl_branch_recurring_schedule_rules
         WHERE fk_branch_id = ?
           AND day_of_week = ?
           AND is_active = 1
           AND ${slotId === null ? 'fk_slot_id IS NULL' : 'fk_slot_id = ?'}
           ${excludeRuleId ? 'AND id <> ?' : ''}
         LIMIT 1`,
        [branchId, dayOfWeek, ...(slotId === null ? [] : [slotId]), ...(excludeRuleId ? [excludeRuleId] : [])]
    );
    if (rows.length > 0) {
        throw new AppError('A weekly rule already exists for this slot and day. Edit the existing rule instead.', 409);
    }
};

/**
 * Re-applies (or removes) a rule on every upcoming matching date. Dates where the doctor set a
 * custom time by hand are left alone; dates whose queue already started are skipped and reported.
 */
const syncRuleToUpcomingDates = async ({
    rule,
    mode, // 'APPLY' | 'REVERT'
    actorUserId,
    ip = null,
    weeksAhead = DEFAULT_WEEKS_AHEAD,
}) => {
    const branchId = Number(rule.fk_branch_id);
    const slotId = rule.fk_slot_id === null
        ? await getFirstActiveSlotId({ executor: query, branchId })
        : Number(rule.fk_slot_id);

    const summary = { updated: 0, skipped: [], untouched: 0, dates: [] };
    if (!slotId) {
        return summary;
    }

    const dates = listUpcomingDatesForDay(rule.day_of_week, weeksAhead);
    const today = getToday();
    // Also cover further-out dates that already have bookings on this weekday.
    const bookedRows = await query(
        `SELECT DISTINCT DATE_FORMAT(appointment_date, '%Y-%m-%d') AS appointment_date
         FROM tbl_appointments
         WHERE fk_branch_id = ? AND fk_slot_id = ? AND appointment_date >= ?
           AND is_active = 1 AND DAYOFWEEK(appointment_date) = ?`,
        [branchId, slotId, today, Number(rule.day_of_week)]
    );
    for (const row of bookedRows) {
        if (!dates.includes(row.appointment_date)) {
            dates.push(row.appointment_date);
        }
    }
    dates.sort();

    const reason = buildRecurringRuleReason(rule);

    for (const appointmentDate of dates) {
        try {
            const changed = await withTransaction(async (connection) => {
                const [existingRows] = await connection.execute(
                    `SELECT id, status, reason
                     FROM tbl_doctor_slot_time_overrides
                     WHERE fk_branch_id = ? AND fk_slot_id = ? AND appointment_date = ?
                     LIMIT 1 FOR UPDATE`,
                    [branchId, slotId, appointmentDate]
                );
                const existing = existingRows[0] || null;
                const isDoctorRow = existing && existing.status === 'ACTIVE' && !isRecurringRuleReason(existing.reason);

                if (isDoctorRow) {
                    return false; // doctor's manual shift for this date wins
                }

                if (mode === 'APPLY') {
                    if (existing && existing.status === 'CANCELLED' && !isRecurringRuleReason(existing.reason)) {
                        return false; // doctor explicitly reset this date to default
                    }
                    const result = await shiftSlotOverrideForDate(connection, {
                        branchId, slotId, appointmentDate,
                        overrideStartTime: String(rule.override_start_time),
                        reason, actorUserId, ip,
                        action: 'WEEKLY_RULE_APPLY',
                    });
                    return Boolean(result);
                }

                if (!existing || existing.status !== 'ACTIVE') {
                    return false;
                }
                const result = await cancelSlotOverrideForDate(connection, {
                    branchId, slotId, appointmentDate, actorUserId, ip,
                    action: 'WEEKLY_RULE_REVERT',
                });
                return Boolean(result);
            });

            if (changed) {
                summary.updated += 1;
                summary.dates.push(appointmentDate);
                await emitTimingUpdated({
                    branchId, slotId, appointmentDate,
                    reason: mode === 'APPLY' ? 'WEEKLY_RULE_APPLY' : 'WEEKLY_RULE_REVERT',
                });
            } else {
                summary.untouched += 1;
            }
        } catch (error) {
            summary.skipped.push({ appointment_date: appointmentDate, reason: error.message });
        }
    }

    return summary;
};

const createRecurringRule = async ({ branchId, slotId = null, dayOfWeek, startTime, description = null, actorUserId, ip = null }) => {
    const normalizedSlotId = slotId === null || slotId === undefined || slotId === '' ? null : toPositiveInt(slotId);
    if (slotId !== null && slotId !== undefined && slotId !== '' && !normalizedSlotId) {
        throw new AppError('slot_id must be a positive integer or null', 400);
    }

    const validated = await validateRuleInput({ branchId, slotId: normalizedSlotId, dayOfWeek, startTime });
    await assertNoDuplicateRule({ branchId, slotId: normalizedSlotId, dayOfWeek: validated.dayOfWeek });

    const normalizedDescription = String(description || '').trim().slice(0, 255) || null;
    const result = await query(
        `INSERT INTO tbl_branch_recurring_schedule_rules
         (fk_branch_id, fk_slot_id, day_of_week, override_start_time, rule_description, is_active)
         VALUES (?, ?, ?, ?, ?, 1)`,
        [branchId, normalizedSlotId, validated.dayOfWeek, validated.startTime, normalizedDescription]
    );

    const rule = await getRecurringRuleById(result.insertId);
    const sync = await syncRuleToUpcomingDates({ rule, mode: 'APPLY', actorUserId, ip });

    return { rule: formatRule(rule, validated.slots), sync };
};

const updateRecurringRule = async ({ ruleId, branchId, slotId, dayOfWeek, startTime, description, actorUserId, ip = null }) => {
    const existing = await getRecurringRuleById(ruleId);
    if (!existing || Number(existing.fk_branch_id) !== Number(branchId)) {
        throw new AppError('Weekly rule not found for the selected branch', 404);
    }

    const hasSlotInput = slotId !== undefined;
    const normalizedSlotId = !hasSlotInput
        ? (existing.fk_slot_id === null ? null : Number(existing.fk_slot_id))
        : (slotId === null || slotId === '' ? null : toPositiveInt(slotId));
    if (hasSlotInput && slotId !== null && slotId !== '' && !normalizedSlotId) {
        throw new AppError('slot_id must be a positive integer or null', 400);
    }

    const validated = await validateRuleInput({
        branchId,
        slotId: normalizedSlotId,
        dayOfWeek: dayOfWeek ?? existing.day_of_week,
        startTime: startTime ?? existing.override_start_time,
    });
    await assertNoDuplicateRule({
        branchId, slotId: normalizedSlotId, dayOfWeek: validated.dayOfWeek, excludeRuleId: Number(ruleId),
    });

    const normalizedDescription = description === undefined
        ? existing.rule_description
        : (String(description || '').trim().slice(0, 255) || null);

    const targetChanged = (
        (existing.fk_slot_id === null ? null : Number(existing.fk_slot_id)) !== normalizedSlotId
        || Number(existing.day_of_week) !== validated.dayOfWeek
    );

    // If the rule now points at a different slot/day, first take it off the old dates.
    let revertSummary = null;
    if (targetChanged && Number(existing.is_active) === 1) {
        revertSummary = await syncRuleToUpcomingDates({ rule: existing, mode: 'REVERT', actorUserId, ip });
    }

    await query(
        `UPDATE tbl_branch_recurring_schedule_rules
         SET fk_slot_id = ?, day_of_week = ?, override_start_time = ?, rule_description = ?, is_active = 1
         WHERE id = ?`,
        [normalizedSlotId, validated.dayOfWeek, validated.startTime, normalizedDescription, ruleId]
    );

    const rule = await getRecurringRuleById(ruleId);
    const sync = await syncRuleToUpcomingDates({ rule, mode: 'APPLY', actorUserId, ip });

    return { rule: formatRule(rule, validated.slots), sync, revertSummary };
};

const deactivateRecurringRule = async ({ ruleId, branchId, actorUserId, ip = null }) => {
    const existing = await getRecurringRuleById(ruleId);
    if (!existing || Number(existing.fk_branch_id) !== Number(branchId)) {
        throw new AppError('Weekly rule not found for the selected branch', 404);
    }
    if (Number(existing.is_active) !== 1) {
        return { rule: formatRule(existing, await listBranchSlots(branchId)), sync: null };
    }

    const sync = await syncRuleToUpcomingDates({ rule: existing, mode: 'REVERT', actorUserId, ip });
    await query(
        'UPDATE tbl_branch_recurring_schedule_rules SET is_active = 0 WHERE id = ?',
        [ruleId]
    );
    const rule = await getRecurringRuleById(ruleId);

    return { rule: formatRule(rule, await listBranchSlots(branchId)), sync };
};

/** Rules that apply to a branch on a given date — used for public / patient-facing notes. */
const listRulesForBranchDate = async ({ branchId, appointmentDate }) => {
    const dayOfWeek = getDayOfWeekForDate(appointmentDate);
    if (!dayOfWeek) {
        return [];
    }
    const slots = await listBranchSlots(branchId);
    const rows = await query(
        `${ruleSelectSql}
         WHERE r.fk_branch_id = ? AND r.day_of_week = ? AND r.is_active = 1
         ORDER BY (r.fk_slot_id IS NULL) DESC, r.override_start_time ASC`,
        [branchId, dayOfWeek]
    );
    return rows.map((row) => formatRule(row, slots));
};

// ---------------------------------------------------------------------------
// Background materialiser: pre-creates override rows for upcoming rule dates so that
// screens which read timings purely via SQL (doctor slot list, reception lists) are correct
// even before the first booking of that date.
// ---------------------------------------------------------------------------

const materializeUpcomingRecurringOverrides = async ({ weeksAhead = DEFAULT_WEEKS_AHEAD } = {}) => {
    const rules = await query(
        `SELECT id, fk_branch_id, fk_slot_id, day_of_week, override_start_time, rule_description
         FROM tbl_branch_recurring_schedule_rules
         WHERE is_active = 1`
    );

    let created = 0;
    for (const rule of rules) {
        const branchId = Number(rule.fk_branch_id);
        const slotId = rule.fk_slot_id === null
            ? await getFirstActiveSlotId({ executor: query, branchId })
            : Number(rule.fk_slot_id);
        if (!slotId) {
            continue;
        }

        for (const appointmentDate of listUpcomingDatesForDay(rule.day_of_week, weeksAhead)) {
            try {
                const timing = await resolveEffectiveSlotTiming({ executor: query, branchId, slotId, appointmentDate });
                if (timing.isRecurringRule) {
                    created += 1;
                }
            } catch (error) {
                console.error(`Weekly rule ${rule.id}: could not materialise ${appointmentDate} for slot ${slotId}:`, error.message);
            }
        }
    }

    return { rules: rules.length, ensured: created };
};

let materializerTimer = null;
let materializerRunning = false;

const runMaterializerSafely = async () => {
    if (materializerRunning) {
        return;
    }
    materializerRunning = true;
    try {
        await materializeUpcomingRecurringOverrides();
    } catch (error) {
        console.error('Weekly schedule materialiser failed:', error);
    } finally {
        materializerRunning = false;
    }
};

const startRecurringScheduleMaterializer = () => {
    if (materializerTimer) {
        return materializerTimer;
    }
    setTimeout(runMaterializerSafely, MATERIALIZER_STARTUP_DELAY_MS).unref?.();
    materializerTimer = setInterval(runMaterializerSafely, MATERIALIZER_INTERVAL_MS);
    return materializerTimer;
};

const stopRecurringScheduleMaterializer = () => {
    if (materializerTimer) {
        clearInterval(materializerTimer);
        materializerTimer = null;
    }
};

module.exports = {
    DEFAULT_WEEKS_AHEAD,
    assertSlotTimingCanShift,
    cancelSlotOverrideForDate,
    createRecurringRule,
    deactivateRecurringRule,
    listRecurringRules,
    listRulesForBranchDate,
    listUpcomingDatesForDay,
    materializeUpcomingRecurringOverrides,
    normalizeTimeInput,
    shiftSlotOverrideForDate,
    startRecurringScheduleMaterializer,
    stopRecurringScheduleMaterializer,
    syncRuleToUpcomingDates,
    updateRecurringRule,
};
