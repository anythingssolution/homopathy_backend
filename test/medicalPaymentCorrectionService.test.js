const test = require('node:test');
const assert = require('node:assert/strict');
const { planReceiptCorrection } = require('../services/medicalPaymentCorrectionService');
const receipt = (id, amount, extra = {}) => ({ id, bill_id: 1, amount, allocation_kind: 'CURRENT', settlement_source_bill_id: 1, ...extra });
const plan = (payments, received, paid = 700.02) => planReceiptCorrection({ payments, received, paid, expectedPaid: paid, total: 700.02 });
test('corrects 700.02 received to 500.02 on the same receipt with 200 pending', () => {
    const [row] = plan([receipt(7, 700.02)], 500.02);
    assert.equal(row.id, 7);
    assert.equal(row.nextAmount, 500.02);
    assert.equal(row.pendingAfter, 200);
});
test('handles zero and restores an existing zero receipt', () => {
    assert.equal(plan([receipt(7, 700.02)], 0)[0].pendingAfter, 700.02);
    assert.equal(plan([receipt(7, 0)], 500.02, 0)[0].nextAmount, 500.02);
});
test('preserves receipt identities, modes and later dues collections', () => {
    const rows = plan([receipt(1, 300, {payment_mode:'CASH'}), receipt(2, 300.02, {payment_mode:'ONLINE'}), receipt(3, 100, {allocation_kind:'PREVIOUS'})], 500.02);
    assert.deepEqual(rows.map(r=>r.nextAmount), [300,100.02,100]);
    assert.equal(rows[1].payment_mode, 'ONLINE');
    assert.equal(rows[2].pendingAfter, 200);
    assert.throws(()=>plan([receipt(1,600.02),receipt(2,100,{allocation_kind:'PREVIOUS'})],50), /later dues/);
});
test('rejects stale, inconsistent, excessive and invalid corrections', () => {
    assert.throws(()=>planReceiptCorrection({payments:[receipt(1,700.02)],received:500.02,total:700.02,paid:700.02,expectedPaid:500}), /Payment changed/);
    assert.throws(()=>plan([receipt(1,700.02)],701), /exceed/);
    assert.throws(()=>plan([receipt(1,700.02)],NaN), /valid/);
    assert.throws(()=>plan([receipt(1,600)],500), /does not match/);
});
