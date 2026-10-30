const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const AppError = require('../utils/AppError');
const source = fs.readFileSync(require.resolve('../controllers/v1/doctor/appointmentsController'), 'utf8');
const start = source.indexOf('const listAppointmentsForDoctor =');
const end = source.indexOf('\nconst ', start + 7);
const now = new Date();
const today = [now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')].join('-');

function fixture({ visibleSlot = 1, validSlot = true } = {}) {
    const queries = [], resolved = [];
    const query = async (sql, params = []) => {
        queries.push({ sql, params });
        assert.match(sql.trim(), /^SELECT/);
        assert.equal((sql.match(/\?/g) || []).length, params.length);
        if (sql.includes('FROM master_slots')) return validSlot ? [{ id: 2 }] : [];
        return [];
    };
    const handler = vm.runInNewContext(`${source.slice(start, end)}; listAppointmentsForDoctor`, {
        asyncHandler: fn => fn, query, AppError,
        toPositiveInt: v => Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : null,
        isValidDateString: v => /^\d{4}-\d{2}-\d{2}$/.test(v),
        normalizeAppointmentStatus: v => ['Pending', 'Confirmed', 'Completed', 'Cancelled'].includes(v) ? v : null,
        resolveDoctorVisibleSlotId: async input => { resolved.push(input); return visibleSlot; },
        DOCTOR_APPOINTMENT_SELECT: 'SELECT a.appointment_id FROM tbl_appointments a',
        sortAppointmentsByRuntimeQueue: rows => rows,
        sortCompletedAppointmentsRecentFirst: rows => rows,
        decorateTokenFields: row => row,
    });
    return { queries, resolved, run: async (filters = {}) => {
        let result;
        await handler({ query: { branch_id: '2', appointment_date: today, ...filters }, user: { id: 9 } }, {
            status() { return this; }, json(value) { result = value; },
        });
        return result;
    }};
}
test('legacy current list keeps active slot and consulted exclusion', async () => {
    const f = fixture(); const result = await f.run();
    assert.equal(f.resolved.length, 1);
    assert.match(f.queries[0].sql, /a.fk_slot_id = \?/);
    assert.match(f.queries[0].sql, /c.id IS NULL/);
    assert.equal(result.meta.filters.resolved_slot_id, 1);
    assert.equal(result.meta.filters.session_scope, 'current');
});
test('all sessions lists completed and pending without resolving or switching current session', async () => {
    const f = fixture(); const result = await f.run({ session_scope: 'all', patient_search: 'Patient' });
    assert.equal(f.resolved.length, 0);
    assert.doesNotMatch(f.queries[0].sql, /c.id IS NULL|a.fk_slot_id = \?/);
    assert.match(f.queries[0].sql, /a.fk_branch_id = \?/);
    assert.match(f.queries[0].sql, /p.full_name LIKE \?/);
    assert.match(f.queries[0].sql, /COALESCE\(sto.override_start_time, s.start_time\) ASC/);
    assert.equal(result.meta.filters.resolved_slot_id, null);
});
test('explicit session verifies branch ownership and supports status filtering', async () => {
    const f = fixture(); const result = await f.run({ session_scope: 'slot', slot_id: '2', status: 'Completed' });
    assert.deepEqual(Array.from(f.queries[0].params), [2, 2]);
    assert.match(f.queries[1].sql, /a.fk_slot_id = \?/);
    assert.match(f.queries[1].sql, /a.status = \?/);
    assert.doesNotMatch(f.queries[1].sql, /c.id IS NULL/);
    assert.equal(f.resolved.length, 0);
    assert.equal(result.meta.filters.list_slot_id, 2);
});
test('invalid session filters and sessions outside selected branch reject', async () => {
    for (const filters of [{ session_scope: 'invalid' }, { session_scope: 'all', branch_id: undefined },
        { session_scope: 'slot' }, { session_scope: 'slot', slot_id: '-1' }, { slot_id: '2' }]) {
        await assert.rejects(fixture().run(filters), { statusCode: 400 });
    }
    const f = fixture({ validSlot: false });
    await assert.rejects(f.run({ session_scope: 'slot', slot_id: '2' }), { statusCode: 400 });
    assert.equal(f.queries.length, 1);
});
test('current view with no visible session stays empty rather than falling back to all sessions', async () => {
    const f = fixture({ visibleSlot: null }); await f.run();
    assert.match(f.queries[0].sql, /1 = 0/);
});
