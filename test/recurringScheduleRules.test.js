const test = require('node:test');
const assert = require('node:assert/strict');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-recurring-rules';
process.env.DB_HOST = process.env.DB_HOST || '127.0.0.1';
process.env.DB_USER = process.env.DB_USER || 'test';
process.env.DB_NAME = process.env.DB_NAME || 'test';

const {
    RECURRING_RULE_REASON_PREFIX,
    SYSTEM_ACTOR_USER_ID,
    buildRecurringRuleReason,
    ensureRecurringSlotOverride,
    findRecurringRuleForSlot,
    getDayOfWeekForDate,
    isRecurringRuleReason,
    resolveEffectiveSlotTiming,
} = require('../services/slotTimeOverrideService');
const {
    listUpcomingDatesForDay,
    normalizeTimeInput,
} = require('../services/recurringScheduleService');

const FRIDAY_RULE = {
    id: 1,
    fk_branch_id: 2,
    fk_slot_id: null,
    day_of_week: 6,
    override_start_time: '15:00:00',
    rule_description: 'Pandri Friday 3 PM',
};

/**
 * Minimal fake executor (function form, like `query`) driven by SQL fragments.
 * `state.overrides` holds rows keyed by `${branch}|${slot}|${date}`.
 */
const createFakeExecutor = ({ rules = [], slots = [], overrides = new Map() } = {}) => {
    const calls = [];
    const executor = async (sql, params = []) => {
        calls.push({ sql, params });

        if (sql.includes('FROM tbl_branch_recurring_schedule_rules') && sql.includes('day_of_week = ?')) {
            const [branchId, dayOfWeek, slotId] = params;
            const matches = rules.filter((rule) => (
                Number(rule.fk_branch_id) === Number(branchId)
                && Number(rule.day_of_week) === Number(dayOfWeek)
                && (rule.is_active === undefined || rule.is_active === 1)
                && (rule.fk_slot_id === null || (slotId !== undefined && Number(rule.fk_slot_id) === Number(slotId)))
            ));
            if (sql.trim().startsWith('SELECT 1')) {
                return matches.length ? [{ 1: 1 }] : [];
            }
            return matches;
        }

        if (sql.includes('FROM master_slots s') && sql.includes('LEFT JOIN tbl_doctor_slot_time_overrides o')) {
            const [date, slotId, branchId] = params;
            const slot = slots.find((entry) => Number(entry.id) === Number(slotId) && Number(entry.fk_branch_id) === Number(branchId));
            if (!slot) return [];
            const override = overrides.get(`${branchId}|${slotId}|${date}`);
            const active = override && override.status === 'ACTIVE' ? override : null;
            return [{
                slot_id: slot.id,
                branch_id: slot.fk_branch_id,
                slot_name: slot.slot_name,
                default_start_time: slot.start_time,
                default_end_time: slot.end_time,
                effective_start_time: active ? active.override_start_time : slot.start_time,
                effective_end_time: active ? active.override_end_time : slot.end_time,
                override_id: active ? active.id : null,
                reason: active ? active.reason : null,
                has_override: active ? 1 : 0,
            }];
        }

        if (sql.includes('FROM master_slots') && sql.includes('LIMIT 1')) {
            const [branchId] = params;
            const branchSlots = slots
                .filter((slot) => Number(slot.fk_branch_id) === Number(branchId) && slot.is_active !== 0)
                .sort((a, b) => a.start_time.localeCompare(b.start_time) || a.id - b.id);
            return branchSlots.length ? [{ id: branchSlots[0].id }] : [];
        }

        if (sql.includes('FROM tbl_doctor_slot_time_overrides') && sql.includes('SELECT id, status')) {
            const [branchId, slotId, date] = params;
            const row = overrides.get(`${branchId}|${slotId}|${date}`);
            return row ? [{ id: row.id, status: row.status }] : [];
        }

        if (sql.includes('INSERT IGNORE INTO tbl_doctor_slot_time_overrides')) {
            const [branchId, slotId, date, defStart, defEnd, ovStart, ovEnd, shift, reason, createdBy] = params;
            const key = `${branchId}|${slotId}|${date}`;
            if (overrides.has(key)) {
                return { insertId: 0, affectedRows: 0 };
            }
            const id = overrides.size + 100;
            overrides.set(key, {
                id, status: 'ACTIVE', reason,
                default_start_time: defStart, default_end_time: defEnd,
                override_start_time: ovStart, override_end_time: ovEnd,
                shift_seconds: shift, created_by: createdBy,
            });
            return { insertId: id, affectedRows: 1 };
        }

        throw new Error(`Unexpected SQL in fake executor: ${sql}`);
    };
    executor.calls = calls;
    executor.overrides = overrides;
    return executor;
};

const BRANCH_2_SLOTS = [
    { id: 3, fk_branch_id: 2, slot_name: 'Morning Session', start_time: '11:30:00', end_time: '17:30:00' },
    { id: 4, fk_branch_id: 2, slot_name: 'Evening Session', start_time: '18:00:00', end_time: '21:00:00' },
];

test('getDayOfWeekForDate uses 1=Sunday..7=Saturday like MySQL DAYOFWEEK()', () => {
    assert.equal(getDayOfWeekForDate('2026-09-11'), 6); // Friday
    assert.equal(getDayOfWeekForDate('2026-09-13'), 1); // Sunday
    assert.equal(getDayOfWeekForDate('2026-09-12'), 7); // Saturday
    assert.equal(getDayOfWeekForDate('not-a-date'), null);
    assert.equal(getDayOfWeekForDate(''), null);
});

test('reason tagging distinguishes auto rule rows from doctor rows', () => {
    const reason = buildRecurringRuleReason(FRIDAY_RULE);
    assert.ok(reason.startsWith(RECURRING_RULE_REASON_PREFIX));
    assert.ok(reason.includes('Pandri Friday 3 PM'));
    assert.equal(isRecurringRuleReason(reason), true);
    assert.equal(isRecurringRuleReason('Doctor running late'), false);
    assert.equal(isRecurringRuleReason(null), false);
    assert.equal(buildRecurringRuleReason({ day_of_week: 2 }), `${RECURRING_RULE_REASON_PREFIX} Monday schedule`);
});

test('findRecurringRuleForSlot: "first slot" rule applies only to the earliest active slot', async () => {
    const executor = createFakeExecutor({ rules: [FRIDAY_RULE], slots: BRANCH_2_SLOTS });

    const forFirstSlot = await findRecurringRuleForSlot({ executor, branchId: 2, slotId: 3, appointmentDate: '2026-09-11' });
    assert.equal(forFirstSlot?.id, 1);

    const forSecondSlot = await findRecurringRuleForSlot({ executor, branchId: 2, slotId: 4, appointmentDate: '2026-09-11' });
    assert.equal(forSecondSlot, null);

    const onSaturday = await findRecurringRuleForSlot({ executor, branchId: 2, slotId: 3, appointmentDate: '2026-09-12' });
    assert.equal(onSaturday, null);

    const otherBranch = await findRecurringRuleForSlot({ executor, branchId: 1, slotId: 3, appointmentDate: '2026-09-11' });
    assert.equal(otherBranch, null);
});

test('findRecurringRuleForSlot: slot-specific rule wins over branch-wide first-slot rule', async () => {
    const specific = { ...FRIDAY_RULE, id: 9, fk_slot_id: 3, override_start_time: '16:00:00' };
    const executor = createFakeExecutor({ rules: [FRIDAY_RULE, specific], slots: BRANCH_2_SLOTS });

    const rule = await findRecurringRuleForSlot({ executor, branchId: 2, slotId: 3, appointmentDate: '2026-09-11' });
    assert.equal(rule?.id, 9);
    assert.equal(rule?.override_start_time, '16:00:00');
});

test('ensureRecurringSlotOverride inserts a system-owned ACTIVE row once and keeps slot duration', async () => {
    const executor = createFakeExecutor({ rules: [FRIDAY_RULE], slots: BRANCH_2_SLOTS });
    const args = {
        executor, branchId: 2, slotId: 3, appointmentDate: '2026-09-11',
        defaultStartTime: '11:30:00', defaultEndTime: '17:30:00',
    };

    const first = await ensureRecurringSlotOverride(args);
    assert.equal(first.applied, true);
    assert.equal(first.override.overrideStartTime, '15:00:00');
    assert.equal(first.override.overrideEndTime, '21:00:00');
    assert.equal(first.override.shiftSeconds, 3.5 * 3600);

    const stored = executor.overrides.get('2|3|2026-09-11');
    assert.equal(stored.status, 'ACTIVE');
    assert.equal(stored.created_by, SYSTEM_ACTOR_USER_ID);
    assert.ok(isRecurringRuleReason(stored.reason));

    const second = await ensureRecurringSlotOverride(args);
    assert.equal(second.applied, false, 'must not insert twice for the same key');
    assert.equal(second.rule?.id, 1);
    assert.equal(executor.overrides.size, 1);
});

test('ensureRecurringSlotOverride never touches an existing (doctor-cancelled) row', async () => {
    const overrides = new Map([['2|3|2026-09-11', { id: 55, status: 'CANCELLED', reason: 'Doctor reset' }]]);
    const executor = createFakeExecutor({ rules: [FRIDAY_RULE], slots: BRANCH_2_SLOTS, overrides });

    const result = await ensureRecurringSlotOverride({
        executor, branchId: 2, slotId: 3, appointmentDate: '2026-09-11',
        defaultStartTime: '11:30:00', defaultEndTime: '17:30:00',
    });
    assert.equal(result.applied, false);
    assert.equal(overrides.get('2|3|2026-09-11').status, 'CANCELLED');
    assert.equal(overrides.size, 1);
});

test('ensureRecurringSlotOverride skips rules that cannot be applied (would cross midnight)', async () => {
    const lateRule = { ...FRIDAY_RULE, override_start_time: '20:00:00' };
    const executor = createFakeExecutor({ rules: [lateRule], slots: BRANCH_2_SLOTS });
    const originalError = console.error;
    console.error = () => {};
    try {
        const result = await ensureRecurringSlotOverride({
            executor, branchId: 2, slotId: 3, appointmentDate: '2026-09-11',
            defaultStartTime: '11:30:00', defaultEndTime: '17:30:00',
        });
        assert.equal(result.applied, false);
        assert.equal(executor.overrides.size, 0);
    } finally {
        console.error = originalError;
    }
});

test('resolveEffectiveSlotTiming materialises the weekly rule and reports it', async () => {
    const executor = createFakeExecutor({ rules: [FRIDAY_RULE], slots: BRANCH_2_SLOTS });

    const friday = await resolveEffectiveSlotTiming({ executor, branchId: 2, slotId: 3, appointmentDate: '2026-09-11' });
    assert.equal(friday.hasOverride, true);
    assert.equal(friday.isRecurringRule, true);
    assert.equal(friday.effectiveStartTime, '15:00:00');
    assert.equal(friday.effectiveEndTime, '21:00:00');
    assert.equal(friday.recurringRule.dayLabel, 'Friday');
    assert.equal(friday.recurringRule.startTime, '15:00:00');
    assert.ok(friday.overrideId);

    // Second resolve reads the row created by the first one (no new insert).
    const again = await resolveEffectiveSlotTiming({ executor, branchId: 2, slotId: 3, appointmentDate: '2026-09-11' });
    assert.equal(again.overrideId, friday.overrideId);
    assert.equal(executor.overrides.size, 1);

    const saturday = await resolveEffectiveSlotTiming({ executor, branchId: 2, slotId: 3, appointmentDate: '2026-09-12' });
    assert.equal(saturday.hasOverride, false);
    assert.equal(saturday.isRecurringRule, false);
    assert.equal(saturday.effectiveStartTime, '11:30:00');
    assert.equal(saturday.recurringRule, null);
});

test('resolveEffectiveSlotTiming keeps a doctor shift and still exposes the rule for context', async () => {
    const overrides = new Map([[
        '2|3|2026-09-11',
        {
            id: 77, status: 'ACTIVE', reason: 'Doctor late today',
            override_start_time: '16:00:00', override_end_time: '22:00:00',
        },
    ]]);
    const executor = createFakeExecutor({ rules: [FRIDAY_RULE], slots: BRANCH_2_SLOTS, overrides });

    const timing = await resolveEffectiveSlotTiming({ executor, branchId: 2, slotId: 3, appointmentDate: '2026-09-11' });
    assert.equal(timing.effectiveStartTime, '16:00:00');
    assert.equal(timing.hasOverride, true);
    assert.equal(timing.isRecurringRule, false);
    assert.equal(timing.recurringRule?.id, 1);
});

test('resolveEffectiveSlotTiming with materializeRule=false returns raw state without inserting', async () => {
    const executor = createFakeExecutor({ rules: [FRIDAY_RULE], slots: BRANCH_2_SLOTS });

    const raw = await resolveEffectiveSlotTiming({
        executor, branchId: 2, slotId: 3, appointmentDate: '2026-09-11', materializeRule: false,
    });
    assert.equal(raw.hasOverride, false);
    assert.equal(raw.effectiveStartTime, '11:30:00');
    assert.equal(executor.overrides.size, 0);
});

test('listUpcomingDatesForDay returns only matching weekdays from today, in order', () => {
    const dates = listUpcomingDatesForDay(6, 3);
    assert.equal(dates.length, 3);
    for (const date of dates) {
        assert.equal(getDayOfWeekForDate(date), 6);
    }
    assert.deepEqual([...dates].sort(), dates);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const first = new Date(`${dates[0]}T00:00:00`);
    assert.ok(first >= today);
});

test('normalizeTimeInput accepts HH:mm / HH:mm:ss and rejects junk', () => {
    assert.equal(normalizeTimeInput('15:00'), '15:00:00');
    assert.equal(normalizeTimeInput('09:05:30'), '09:05:30');
    assert.equal(normalizeTimeInput('9:5'), null);
    assert.equal(normalizeTimeInput('25:00'), null);
    assert.equal(normalizeTimeInput(''), null);
});
