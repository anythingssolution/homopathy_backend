const test = require('node:test');
const assert = require('node:assert/strict');
const { buildDocumentModel, normalizePhone } = require('../services/dispensarySharing/model');
const { renderDispensaryDocument } = require('../services/dispensarySharing/document');
const bill = { bill_id: 8, bill_number: 'MED-8', status: 'ACTIVE', created_at: '2026-10-09T09:00:00Z', gross_amount: 400, discount_amount: 20, total_amount: 380, paid_amount: 180, pending_amount: 200,
  items: [{ item_name: 'Medicine A', item_type: 'MEDICATION', quantity: 1, amount: 100 }, { item_name: 'CBC', item_type: 'TEST', quantity: 1, amount: 300 }],
  payments: [{ payment_id: 2, status: 'SUCCESS', amount: 180, bill_number: 'MED-8', payment_mode: 'CASH', collected_at: '2026-10-09T09:00:00Z' }],
  previous_pending_settlements: [{ payment_id: 3, status: 'SUCCESS', amount: 50, bill_number: 'MED-7', payment_mode: 'CASH', collected_at: '2026-10-09T09:00:00Z' }],
};
const patient = { full_name: 'Test Patient', uuid: 'DTH-TEST' };
test('bill sharing uses saved totals and includes tests, without recomputing product prices', () => {
  const model = buildDocumentModel(bill, patient);
  assert.equal(model.lines[1].name, 'CBC');
  assert.deepEqual(model.totals[2], ['Net bill', 380]);
  assert.equal(model.fingerprint, buildDocumentModel(bill, patient).fingerprint);
  assert.notEqual(model.fingerprint, buildDocumentModel({ ...bill, pending_amount: 0 }, patient).fingerprint);
});
test('receipt includes only selected successful payments; rejects unrelated payment IDs', () => {
  const model = buildDocumentModel(bill, patient, { kind: 'RECEIPT', payment_ids: [3] });
  assert.deepEqual(model.totals, [['Total received', 50]]);
  assert.equal(model.lines.length, 1);
  assert.match(model.lines[0].name, /MED-7/);
  assert.throws(() => buildDocumentModel(bill, patient, { kind: 'RECEIPT', payment_ids: [99] }), /unavailable/);
  assert.throws(() => buildDocumentModel({ ...bill, status: 'CANCELLED' }, patient), /active/);
});
test('recipient validation handles Indian/local and country-code numbers without accepting malformed input', () => {
  assert.equal(normalizePhone('9827159733'), '919827159733');
  assert.equal(normalizePhone('+91 98271 59733'), '919827159733');
  assert.throws(() => normalizePhone('123'), /valid/);
  assert.throws(() => normalizePhone('abc9827159733'), /valid/);
});
test('bill and receipt both generate actual PDF documents', async () => {
  for (const options of [{ kind: 'BILL' }, { kind: 'RECEIPT', payment_ids: [2, 3] }]) {
    const pdf = await renderDispensaryDocument(buildDocumentModel(bill, patient, options));
    assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
    assert.ok(pdf.length > 1000);
    assert.match(pdf.subarray(-30).toString(), /%%EOF/);
  }
});
