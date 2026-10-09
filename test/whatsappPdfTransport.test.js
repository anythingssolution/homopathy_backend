const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const load = (uploadOk = true) => {
  const module = { exports: {} }; let uploaded;
  const env = { whatsapp: { accessToken: 'test', phoneNumberId: 'test', apiVersion: 'v22.0', requestTimeoutMs: 1000 } };
  vm.runInNewContext(fs.readFileSync(require.resolve('../services/whatsapp/providers/MetaWhatsAppProvider'), 'utf8'), {
    module, require: name => name === '../../../config/env' ? { env } : name === '../../../config/db' ? { query: async () => ({ insertId: 1 }) } : name === './WhatsAppProviderInterface' ? require('../services/whatsapp/providers/WhatsAppProviderInterface') : require(name),
    FormData, Blob, AbortSignal, Buffer,
    fetch: async (_url, options) => { uploaded = options.body; return { ok: uploadOk, json: async () => uploadOk ? ({ id: 'uploaded-media-id' }) : ({ error: {} }) }; },
  });
  return { provider: new module.exports(), upload: () => uploaded };
};
test('PDF buffer is uploaded and sent by media ID rather than exposing clinic document URL', async () => {
  const s = load(); let payload;
  s.provider.postJson = async (_url, body) => { payload = body; return { messages: [{ id: 'message-id' }] }; };
  const result = await s.provider.sendDocumentMessage({ mobileNo: '919827159733', documentBuffer: Buffer.from('%PDF-test'), documentUrl: 'internal-reference', filename: 'Bill.pdf' });
  assert.equal(result.status, 'sent');
  assert.equal(s.upload().get('file').type, 'application/pdf');
  assert.equal(payload.document.id, 'uploaded-media-id');
  assert.equal(payload.document.link, undefined);
});
test('failed PDF upload records failure and does not submit a document message', async () => {
  const s = load(false); let called = false;
  s.provider.postJson = async () => { called = true; };
  const result = await s.provider.sendDocumentMessage({ mobileNo: '919827159733', documentBuffer: Buffer.from('%PDF-test'), filename: 'Bill.pdf' });
  assert.equal(result.status, 'failed'); assert.equal(called, false);
});
test('existing document URL callers retain their transport unchanged', async () => {
  const s = load(); let payload;
  s.provider.postJson = async (_url, body) => { payload = body; return { messages: [{ id: 'message-id' }] }; };
  const result = await s.provider.sendDocumentMessage({ mobileNo: '919827159733', documentUrl: 'https://clinic.example/Bill.pdf', filename: 'Bill.pdf' });
  assert.equal(result.status, 'sent'); assert.equal(payload.document.link, 'https://clinic.example/Bill.pdf'); assert.equal(s.upload(), undefined);
});
