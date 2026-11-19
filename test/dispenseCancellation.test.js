const test = require('node:test');
const assert = require('node:assert/strict');
const { cancelPendingDispense } = require('../services/dispenseCancellationService');
function fixture(status = 'READY_FOR_MEDICAL', bills = []) {
 const writes = [];
 const connection = { execute: async (sql, params) => {
  assert.equal((sql.match(/\?/g) || []).length, params.length);
  if (sql.startsWith('SELECT c.id')) return [[{ id: 9, workflow_status: status, fk_branch_id: 2 }]];
  if (sql.startsWith('SELECT id, paid_amount')) return [bills];
  writes.push({ sql, params }); return [{ affectedRows: 1 }];
 } };
 return { connection, writes };
}
const request = { consultationId: 9, branchId: 2, actorId: 7, deliveryMode: 'COURIER', reason: ' Patient did not collect ' };
test('pending cancellation records delivery, reason, actor and timestamp without touching appointment/prescription items', async () => {
 const f = fixture(); const result = await cancelPendingDispense(f.connection, request);
 assert.equal(result.reason, 'Patient did not collect'); assert.equal(result.delivery_mode, 'COURIER'); assert.equal(result.cancelled_by, 7); assert.ok(result.cancelled_at);
 assert.equal(f.writes.length, 1); assert.match(f.writes[0].sql, /DISPENSE_CANCELLED/);
});
test('hand delivery cancellation deactivates only unpaid medication draft bills', async () => {
 const f = fixture('READY_FOR_MEDICAL', [{ id: 22, paid_amount: 0 }]);
 const result = await cancelPendingDispense(f.connection, { ...request, deliveryMode: 'HAND_DELIVERY' });
 assert.equal(result.delivery_mode, 'HAND_DELIVERY'); assert.match(f.writes[1].sql, /status = 'CANCELLED'/); assert.deepEqual(f.writes[1].params, [22]);
});
test('processed, duplicate, wrong branch, invalid input and payment-bearing entries reject before any writes', async () => {
 for (const status of ['PROCESSED_BY_MEDICAL','DISPENSE_CANCELLED','DRAFT','COMPLETED_NO_PRESCRIPTION']) {
  const f = fixture(status); await assert.rejects(cancelPendingDispense(f.connection, request), e => e.statusCode === 409); assert.equal(f.writes.length,0);
 }
 for (const patch of [{ branchId: 1 }, { reason: '' }, { reason: 'x'.repeat(1001) }, { deliveryMode: 'INVALID' }]) {
  const f = fixture(); await assert.rejects(cancelPendingDispense(f.connection, { ...request, ...patch })); assert.equal(f.writes.length,0);
 }
 const f = fixture('READY_FOR_MEDICAL',[{ id:22,paid_amount:1 }]); await assert.rejects(cancelPendingDispense(f.connection, request), e=>e.statusCode===409); assert.equal(f.writes.length,0);
});
