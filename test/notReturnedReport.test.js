const test = require('node:test');
const assert = require('node:assert/strict');

test('not-returned report uses latest visit, separate family subjects and calendar-month boundaries', async t => {
    const shared = require.resolve('../services/reports/shared');
    const report = require.resolve('../services/reports/patient/notReturned');
    const original = require.cache[shared];
    let captured;
    require.cache[shared] = { id: shared, filename: shared, loaded: true, exports: { query: async (sql, params) => { captured = { sql, params }; return []; } } };
    delete require.cache[report];
    t.after(() => { delete require.cache[report]; if (original) require.cache[shared] = original; else delete require.cache[shared]; });
    const { buildNotReturnedReport, monthsBefore, getNotReturnedReport } = require(report);
    const patient = (id, date, extra = {}) => ({ fk_patient_id: id, consultation_id: id, patient_full_name: `Patient ${id}`, last_visit_date: date, ...extra });
    const result = buildNotReturnedReport([
        patient(1, '2026-08-01'), patient(1, '2026-10-01'), // Returned recently: exclude.
        patient(2, '2026-09-17'), patient(3, '2026-08-17'), patient(4, '2026-07-17'),
        patient(5, '2026-09-18'), // Less than one month: exclude.
        patient(2, '2026-06-01', { family_member_id: 7, due_date: '2026-06-20', next_appointment: '2026-10-20', last_medicine_date: '2026-10-10' }),
        patient(6, '2026-08-01', { due_date: '2026-11-01' }), // Long interval does not imply overdue.
        patient(7, '2026-08-01', { due_date: '2026-08-15', follow_up_chain_closed: 1 }),
    ], '2026-10-17');
    assert.equal(result.rows.length, 6);
    assert.equal(result.rows.find(row => row.subject_key === 'PAT:2').bucket, '1_2');
    assert.equal(result.rows.find(row => row.subject_key === 'PAT:3').bucket, '2_3');
    assert.equal(result.rows.find(row => row.subject_key === 'PAT:4').bucket, '3_plus');
    assert.equal(result.rows.find(row => row.subject_key === 'FM:7').next_appointment, '2026-10-20');
    assert.equal(result.rows.find(row => row.subject_key === 'FM:7').last_medicine_date, '2026-10-10');
    assert.equal(result.rows.find(row => row.subject_key === 'PAT:6').overdue_days, 0);
    assert.equal(result.rows.find(row => row.subject_key === 'PAT:7').overdue_days, 0);
    assert.equal(monthsBefore('2026-03-31', 1), '2026-02-28');
    assert.equal(monthsBefore('2024-03-31', 1), '2024-02-29');
    assert.equal(monthsBefore('2026-01-31', 3), '2025-10-31');
    await assert.rejects(getNotReturnedReport({ branchId: null }), /select a branch/);
    await getNotReturnedReport({ branchId: 2 });
    assert.equal(captured.params[2], 2);
    assert.match(captured.sql, /a.fk_branch_id=\? AND a.is_active=1 AND a.status='Completed'/);
    assert.match(captured.sql, /newer.fk_patient_family_member_id <=> a.fk_patient_family_member_id/);
    assert.match(captured.sql, /pf.status IN \('PENDING','NOTIFIED','CONFIRMED_BOOKED'\)/);
    assert.match(captured.sql, /mb.appointment_id IS NULL/);
    assert.match(captured.sql, /REJECTED_BY_RECEPTION/);
    assert.doesNotMatch(captured.sql, /INSERT|UPDATE|DELETE/);
});
