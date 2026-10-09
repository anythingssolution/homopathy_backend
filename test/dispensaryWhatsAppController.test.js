const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { buildDocumentModel } = require('../services/dispensarySharing/model');
const baseBill = { bill_id: 8, bill_type: 'MEDICATION', status: 'ACTIVE', branch_id: 1, patient_id: 7, bill_number: 'MED-8', created_at: '2026-10-09T09:00:00Z', total_amount: 100, items: [{ item_name: 'CBC', item_type: 'TEST', amount: 100, quantity: 1 }] };
const patient = { id: 7, full_name: 'Test Patient', uuid: 'DTH-TEST', mobile_no: '9827159733', whatsapp_consent_status: 'OPTED_IN' };
function setup({ selectedBranch = 1, consent = 'OPTED_IN', configured = 'mock', fingerprint } = {}) {
  const durable = new Map(); let deliveries = 0;
  const currentPatient = { ...patient, whatsapp_consent_status: consent };
  const bill = { ...baseBill };
  const connection = { query: async (sql, params) => sql.includes('GET_LOCK') ? [[{ acquired: 1 }]] : sql.includes('RELEASE_LOCK') ? [[{}]] : [[...(durable.has(params[1]) ? [durable.get(params[1])] : [])]], release() {} };
  const deps = {
    '../../utils/asyncHandler': fn => fn,
    '../../utils/AppError': require('../utils/AppError'),
    '../../config/db': { query: async () => [currentPatient], pool: { getConnection: async () => connection } },
    '../../services/billingService': { getBillDetailById: async () => bill },
    '../../services/dispensarySharing/document': { renderDispensaryDocument: async () => Buffer.from('%PDF-test') },
    '../../services/dispensarySharing/model': require('../services/dispensarySharing/model'),
    '../../services/whatsapp/WhatsAppProviderFactory': { getProvider: () => ({ getProviderName: () => 'MOCK', sendDocumentMessage: async options => {
      deliveries++; durable.set(options.documentUrl, { id: 1, status: 'sent', provider_message_id: 'mock_msg_test' });
      return { messageId: 1, status: 'sent' };
    } }) },
    '../../config/env': { env: { whatsapp: {} } },
  };
  const load = () => {
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(require.resolve('../controllers/v1/dispensaryWhatsAppController'), 'utf8'), { module, require: name => deps[name] || require(name), process: { env: { WHATSAPP_PROVIDER: configured } }, Buffer });
    return module.exports;
  };
  const req = { params: { bill_id: '8' }, user: { id: 1, selected_branch_id: selectedBranch }, body: { kind: 'BILL', recipient_phone: patient.mobile_no, request_id: '12345678-1234-1234-1234-123456789012', fingerprint: fingerprint || buildDocumentModel(bill, currentPatient).fingerprint } };
  const response = () => ({ status(value) { this.code = value; return this; }, json(value) { this.body = value; } });
  return { load, req, response, deliveries: () => deliveries };
}
test('sharing rejects another branch, opt-out, changed document and missing live configuration before transmission', async () => {
  for (const [options, pattern] of [[{ selectedBranch: 2 }, /branch/], [{ consent: 'OPTED_OUT' }, /opted out/], [{ fingerprint: 'changed' }, /changed/], [{ configured: 'meta' }, /not configured/]]) {
    const s = setup(options);
    await assert.rejects(s.load().send(s.req, s.response()), pattern);
    assert.equal(s.deliveries(), 0);
  }
});
test('repeated sends share one operation, including after controller reload using durable message identity', async () => {
  const s = setup(); const controller = s.load(); const first = s.response(); const second = s.response();
  await Promise.all([controller.send(s.req, first), controller.send(s.req, second)]);
  assert.equal(s.deliveries(), 1);
  assert.equal(first.body.data.simulated, true);
  assert.match(first.body.message, /No message/);
  await s.load().send(s.req, s.response());
  assert.equal(s.deliveries(), 1);
});
