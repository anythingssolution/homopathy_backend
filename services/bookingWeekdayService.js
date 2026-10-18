const { createHash } = require('crypto');
const { query, withTransaction } = require('../config/db');
const AppError = require('../utils/AppError');
const { getDayOfWeekForDate, DAY_OF_WEEK_LABELS, calculateShiftedTiming } = require('./slotTimeOverrideService');

const read = async (executor, sql, params = []) => {
    if (typeof executor === 'function') return executor(sql, params);
    const [rows] = await executor.execute(sql, params);
    return rows;
};
const validDate = (date) => /^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))
    && !Number.isNaN(Date.parse(`${date}T00:00:00Z`))
    && new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date;
const validateDate = (date) => {
    if (!validDate(date)) throw new AppError('date must be a valid YYYY-MM-DD date', 400);
};
const settingKey = (slot, day) => `${Number(slot)}:${Number(day)}`;
const branchClosureReason = (slots) => [...new Set(slots.map(slot => slot.reason).filter(Boolean))].join(' ');
const toMatrix = (slots, settings) => {
    const saved = new Map(settings.map(row => [settingKey(row.fk_slot_id, row.day_of_week), Number(row.booking_enabled) === 1]));
    return slots.map(slot => ({ ...slot, weekdays: Array.from({ length: 7 }, (_, i) => ({
        day_of_week: i + 1, booking_enabled: saved.get(settingKey(slot.slot_id, i + 1)) ?? true,
    })) }));
};
const revisionFor = (slots) => createHash('sha256').update(JSON.stringify(slots.map(slot => ({
    slot_id: Number(slot.slot_id), branch_id: Number(slot.branch_id),
    weekdays: slot.weekdays,
})))).digest('hex');
const slotSql = `SELECT s.id AS slot_id, s.fk_branch_id AS branch_id, b.branch_name,
    s.slot_name, s.start_time, s.end_time
    FROM master_slots s JOIN master_clinic_branches b ON b.id = s.fk_branch_id
    WHERE s.is_active = 1 AND b.is_active = 1`;
const getDoctorSlots = (executor, doctorId, lock = false) => read(executor, `${slotSql}
    AND EXISTS (SELECT 1 FROM tbl_user_branch_access a WHERE a.user_id = ?
        AND a.branch_id = b.id AND a.is_active = 1)
    ORDER BY s.id${lock ? ' FOR UPDATE' : ''}`, [doctorId]);
const getSettings = (executor, ids, lock = '') => ids.length ? read(executor,
    `SELECT fk_slot_id, day_of_week, booking_enabled FROM tbl_branch_slot_booking_weekdays
     WHERE fk_slot_id IN (${ids.map(() => '?').join(',')}) ORDER BY fk_slot_id, day_of_week${lock}`, ids) : [];

// Read-only weekly timing preview. Date-specific overrides remain in the existing booking flow.
const withWeeklyTimings = (slots, rules) => slots.map(slot => {
    const first = slots.filter(item => Number(item.branch_id) === Number(slot.branch_id))
        .sort((a, b) => String(a.start_time).localeCompare(String(b.start_time)) || Number(a.slot_id) - Number(b.slot_id))[0];
    return { ...slot, weekly_timings: Array.from({ length: 7 }, (_, index) => {
        const day = index + 1;
        const candidates = rules.filter(rule => Number(rule.fk_branch_id) === Number(slot.branch_id) && Number(rule.day_of_week) === day)
            .sort((a, b) => Number(b.id) - Number(a.id));
        const rule = candidates.find(item => item.fk_slot_id != null && Number(item.fk_slot_id) === Number(slot.slot_id))
            || (Number(first?.slot_id) === Number(slot.slot_id) ? candidates.find(item => item.fk_slot_id == null) : null);
        let start = slot.start_time, end = slot.end_time;
        if (rule) {
            try {
                const shifted = calculateShiftedTiming({ defaultStartTime: String(start), defaultEndTime: String(end), overrideStartTime: String(rule.override_start_time) });
                start = shifted.overrideStartTime; end = shifted.overrideEndTime;
            } catch { /* Match existing timing logic: invalid shifts keep the default time. */ }
        }
        return { day_of_week: day, start_time: start, end_time: end,
            has_weekly_override: String(start) !== String(slot.start_time) || String(end) !== String(slot.end_time) };
    }) };
});
const decorateWeeklyTimings = async (executor, slots) => {
    const branches = [...new Set(slots.map(slot => Number(slot.branch_id)))];
    if (!branches.length) return slots;
    const rules = await read(executor, `SELECT id, fk_branch_id, fk_slot_id, day_of_week, override_start_time
        FROM tbl_branch_recurring_schedule_rules WHERE is_active = 1
        AND fk_branch_id IN (${branches.map(() => '?').join(',')})`, branches);
    return withWeeklyTimings(slots, rules);
};

const getDoctorBookingWeekdays = async (doctorId) => {
    const slots = await getDoctorSlots(query, doctorId);
    const matrix = toMatrix(slots, await getSettings(query, slots.map(s => s.slot_id)));
    return { slots: await decorateWeeklyTimings(query, matrix), revision: revisionFor(matrix) };
};
const validateChanges = (changes, slots) => {
    if (!Array.isArray(changes) || changes.length !== slots.length * 7 || !slots.length) {
        throw new AppError('Send all seven weekdays for every accessible active slot. Reload the schedule.', 400);
    }
    const allowed = new Set(slots.map(s => Number(s.slot_id)));
    const seen = new Set();
    for (const item of changes) {
        if (!item || !Number.isInteger(item.slot_id) || !allowed.has(item.slot_id)
            || !Number.isInteger(item.day_of_week) || item.day_of_week < 1 || item.day_of_week > 7
            || typeof item.booking_enabled !== 'boolean' || seen.has(settingKey(item.slot_id, item.day_of_week))) {
            throw new AppError('Invalid, duplicate or unauthorized slot/weekday setting.', 400);
        }
        seen.add(settingKey(item.slot_id, item.day_of_week));
    }
};
const saveDoctorBookingWeekdays = async ({ doctorId, revision, changes }) => withTransaction(async connection => {
    // The same slot locks are held by final booking validation, including when no settings exist yet.
    const slots = await getDoctorSlots(connection, doctorId, true);
    validateChanges(changes, slots);
    const ids = slots.map(s => s.slot_id);
    const current = toMatrix(slots, await getSettings(connection, ids, ' FOR UPDATE'));
    if (typeof revision !== 'string' || revision !== revisionFor(current)) {
        throw new AppError('Schedule changed in another window. Reload before saving.', 409);
    }
    for (const item of [...changes].sort((a, b) => a.slot_id - b.slot_id || a.day_of_week - b.day_of_week)) {
        await connection.execute(`INSERT INTO tbl_branch_slot_booking_weekdays
            (fk_slot_id, day_of_week, booking_enabled, created_by, updated_by) VALUES (?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE booking_enabled = VALUES(booking_enabled), updated_by = VALUES(updated_by)`,
        [item.slot_id, item.day_of_week, item.booking_enabled ? 1 : 0, doctorId, doctorId]);
    }
    const matrix = toMatrix(slots, await getSettings(connection, ids, ' FOR UPDATE'));
    return { slots: await decorateWeeklyTimings(connection, matrix), revision: revisionFor(matrix) };
});

const slotAvailability = (slot, day) => {
    const enabled = slot.weekdays.find(item => item.day_of_week === day)?.booking_enabled ?? true;
    const days = slot.weekdays.filter(item => item.booking_enabled).map(item => DAY_OF_WEEK_LABELS[item.day_of_week]);
    return { slot_id: Number(slot.slot_id), slot_name: slot.slot_name, booking_enabled: enabled,
        available_days: days,
        reason: enabled ? null : days.length
            ? `Booking for ${slot.slot_name} is available only on ${days.join(', ')}.`
            : `Booking for ${slot.slot_name} is currently closed on all days.` };
};
const getWeeklyBranchStatus = async ({ branchId, appointmentDate, executor = query }) => {
    validateDate(appointmentDate);
    const slots = await read(executor, `${slotSql} AND b.id = ? ORDER BY s.id`, [branchId]);
    const matrix = toMatrix(slots, await getSettings(executor, slots.map(s => s.slot_id)));
    const statuses = matrix.map(slot => slotAvailability(slot, getDayOfWeekForDate(appointmentDate)));
    return { booking_enabled: statuses.some(slot => slot.booking_enabled), slots: statuses,
        reason: statuses.some(slot => slot.booking_enabled) ? null
            : statuses.length ? branchClosureReason(statuses) : 'No active booking sessions for this branch.' };
};
const getDateBookingAvailability = async (appointmentDate) => {
    validateDate(appointmentDate);
    const [slots, leaves] = await Promise.all([
        query(`${slotSql} ORDER BY s.id`),
        query(`SELECT DISTINCT fk_branch_id FROM tbl_branch_doctor_leaves WHERE leave_date = ? AND status = 'ACTIVE'`, [appointmentDate]),
    ]);
    const matrix = toMatrix(slots, await getSettings(query, slots.map(s => s.slot_id)));
    const onLeave = new Set(leaves.map(row => Number(row.fk_branch_id)));
    const branches = new Map();
    for (const slot of matrix) {
        const id = Number(slot.branch_id);
        if (!branches.has(id)) branches.set(id, { branch_id: id, slots: [] });
        const status = slotAvailability(slot, getDayOfWeekForDate(appointmentDate));
        if (onLeave.has(id)) { status.booking_enabled = false; status.reason = 'Doctor is not available in this clinic on the selected date (leave).'; }
        branches.get(id).slots.push(status);
    }
    return { appointment_date: appointmentDate, branches: [...branches.values()].map(branch => ({
        ...branch, booking_enabled: branch.slots.some(slot => slot.booking_enabled),
        reason: branch.slots.some(slot => slot.booking_enabled) ? null : branchClosureReason(branch.slots),
    })) };
};
const assertWeeklyBookingOpen = async ({ branchId, slotId, appointmentDate, connection = null, executor = query }) => {
    validateDate(appointmentDate);
    const execute = connection || executor;
    const slots = await read(execute, `SELECT id FROM master_slots WHERE id = ? AND fk_branch_id = ? AND is_active = 1${connection ? ' LOCK IN SHARE MODE' : ''}`, [slotId, branchId]);
    if (!slots.length) throw new AppError('Selected slot not found for the selected branch', 404);
    const settings = await getSettings(execute, [slotId], connection ? ' LOCK IN SHARE MODE' : '');
    const status = slotAvailability(toMatrix([{ slot_id: slotId, slot_name: 'this session' }], settings)[0], getDayOfWeekForDate(appointmentDate));
    if (!status.booking_enabled) throw new AppError(status.reason, 409, { code: 'BOOKING_WEEKDAY_CLOSED', slot_id: slotId, appointment_date: appointmentDate });
};
module.exports = { getDoctorBookingWeekdays, saveDoctorBookingWeekdays, getDateBookingAvailability,
    getWeeklyBranchStatus, assertWeeklyBookingOpen, toMatrix, revisionFor, validateChanges, slotAvailability, validDate, withWeeklyTimings };
