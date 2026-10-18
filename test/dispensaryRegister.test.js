const test = require('node:test');
const assert = require('node:assert/strict');

test('dispensary uses current backlog and actual medical bills without changing existing medical reports', async t => {
    const shared = require.resolve('../services/reports/shared');
    const service = require.resolve('../services/reports/medical/dispensaryRegister');
    const original = require.cache[shared]; const calls = [];
    const pending = [{ consultation_id: 1, token_number: 30, original_token_number: 27, slot_name: 'Morning Session', start_time: '09:00:00' }];
    const bills = [
        { bill_id: 1, bill_date: '2026-10-17', total_amount: '550.00', paid_amount: '400.00', pending_amount: '150.00' },
        { bill_id: 2, bill_date: '2026-10-16', total_amount: '100.00', paid_amount: '100.00', pending_amount: '0.00' },
        { bill_id: 3, bill_date: '2026-10-17', total_amount: '150.00', paid_amount: '0.00', pending_amount: '150.00' },
    ];
    require.cache[shared] = { id: shared, filename: shared, loaded: true, exports: { query: async (sql,params) => {
        calls.push({sql,params});
        if (sql.includes('FROM tbl_consultations c JOIN')) return pending;
        if (sql.includes('FROM tbl_bills b')) return bills;
        return [{medicine_name:'17',bill_count:2}];
    } } };
    delete require.cache[service];
    t.after(() => { delete require.cache[service]; if (original) require.cache[shared] = original; else delete require.cache[shared]; });
    const { getDispensaryRegister, summarizeDispensary } = require(service);
    await assert.rejects(getDispensaryRegister({branchId:null}),/select a branch/);
    const result = await getDispensaryRegister({branchId:2,fromDate:'2026-10-01',toDate:'2026-10-17'});
    assert.deepEqual(result.summary,{pending_count:1,dispensed_bills:3,net_billed:800,paid:500,pending:300});
    assert.deepEqual(result.trend,[{date:'2026-10-16',bills:1,net_billed:100},{date:'2026-10-17',bills:2,net_billed:700}]);
    assert.equal(result.pending[0].display_token_display,'M-27');
    assert.match(calls[0].sql,/a.is_active=1 AND a.status='Completed'/);
    assert.match(calls[0].sql,/c.workflow_status='READY_FOR_MEDICAL'/);
    assert.doesNotMatch(calls[0].sql,/appointment_date>=|appointment_date<=/);
    assert.equal(calls[0].params[1],2);
    for (const call of calls.slice(1)) {
        assert.deepEqual(call.params,[2,'2026-10-01','2026-10-17']);
        assert.match(call.sql,/b.status='ACTIVE'/);
        assert.match(call.sql,/DATE\(b.created_at\)>=\?/);
    }
    assert.match(calls[2].sql,/COUNT\(DISTINCT bi.bill_id\)/);
    assert.match(calls[2].sql,/IN \('MEDICATION','ADDITIONAL_MEDICATION'\)/);
    assert.deepEqual(summarizeDispensary([],[]).summary,{pending_count:0,dispensed_bills:0,net_billed:0,paid:0,pending:0});
    assert.equal(summarizeDispensary([],[{bill_date:'2026-10-17',total_amount:0.1},{bill_date:'2026-10-17',total_amount:0.2}]).summary.net_billed,0.3);
});
