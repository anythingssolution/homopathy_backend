const test = require('node:test');
const assert = require('node:assert/strict');

test('appointment card lists keep existing report scope, status categories and original token display', async t => {
    const shared = require.resolve('../services/reports/appointment/shared');
    const service = require.resolve('../services/reports/appointment/appointmentList');
    const original = require.cache[shared];
    const calls = [];
    require.cache[shared] = { id: shared, filename: shared, loaded: true, exports: {
        buildAppointmentReportScope: filters => ({ whereClause: 'WHERE a.appointment_date >= ? AND a.appointment_date <= ? AND a.fk_branch_id = ?', params: [filters.fromDate, filters.toDate, filters.branchId] }),
        query: async (sql, params) => { calls.push({ sql, params }); return [{ appointment_id: 1, token_number: 18, original_token_number: 11, slot_name: 'Evening', start_time: '18:00:00', queue_position: 5 }]; },
    } };
    delete require.cache[service];
    t.after(() => { delete require.cache[service]; if (original) require.cache[shared] = original; else delete require.cache[shared]; });
    const { getAppointmentList, CARD_STATUSES } = require(service);
    for (const status of Object.keys(CARD_STATUSES)) {
        const data = await getAppointmentList({ fromDate: '2026-10-01', toDate: '2026-10-17', branchId: 2, status });
        const call = calls.at(-1);
        assert.deepEqual(call.params, ['2026-10-01', '2026-10-17', 2, ...CARD_STATUSES[status]]);
        assert.match(call.sql, /c.id=\(SELECT MAX\(latest.id\)/);
        assert.match(call.sql, /LEFT JOIN master_users/);
        assert.doesNotMatch(call.sql, /WHERE a.is_active=1/);
        assert.doesNotMatch(call.sql, /OR c.id IS NOT NULL/);
        assert.equal(data.rows[0].display_token_display, 'E-11');
        assert.equal(data.rows[0].queue_position, 5);
    }
    await assert.rejects(getAppointmentList({ status: 'constructor' }), /Invalid appointment card/);
    assert.equal(calls.length, 4);
    assert.deepEqual(CARD_STATUSES.pending, ['Pending', 'Confirmed']);
});
