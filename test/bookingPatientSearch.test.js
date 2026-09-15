const test = require('node:test');
const assert = require('node:assert/strict');
process.env.JWT_SECRET = 'booking-search-test';
process.env.DB_HOST = '127.0.0.1';
process.env.DB_USER = 'test';
process.env.DB_NAME = 'test';
const db = require('../config/db');
let calls = [];
db.query = async (sql, params) => {
  calls.push({sql, params});
  return sql.includes('COUNT(*) AS total') ? [{total: 0}] : [];
};
db.withTransaction = async fn => fn({execute: async (sql, params) => {
  calls.push({sql, params});
  assert.match(sql, /WHERE mobile_no = \?/);
  return [[{id: 42, role: 'PAT', is_active: 1}]];
}});
const controller = require('../controllers/v1/receptionistController');
const invoke = (fn, req) => new Promise((resolve, reject) => fn(req, {status() {return this;}, json: resolve}, reject));

test('ID lookup searches both IDs only and binds exact-match priority after filter parameters', async () => {
  calls = [];
  await invoke(controller.listReceptionistPatients, {query: {search: 'DTH42', search_by: 'id'}});
  const list = calls.find(c => c.sql.includes('LIMIT'));
  assert.match(list.sql, /u\.uuid LIKE \? OR u\.clinic_patient_no LIKE \?/);
  assert.doesNotMatch(list.sql, /u\.full_name LIKE|u\.mobile_no LIKE/);
  assert.match(list.sql, /CASE WHEN u\.uuid = \? OR u\.clinic_patient_no = \? THEN 0/);
  assert.deepEqual(list.params, ['%DTH42%', '%DTH42%', 'DTH42', 'DTH42']);
  assert.match(list.sql, /u\.is_active = 1/);
  assert.doesNotMatch(list.sql, /a_branch/);
});

test('name/mobile search retains its existing matching fields', async () => {
  calls = [];
  await invoke(controller.listReceptionistPatients, {query: {search: 'Ravi'}});
  const list = calls.find(c => c.sql.includes('LIMIT'));
  assert.match(list.sql, /u\.full_name LIKE \? OR u\.mobile_no LIKE/);
  assert.equal(list.params.length, 5);
  assert.doesNotMatch(list.sql, /CASE WHEN/);
});

test('new-patient request with an existing mobile stops before creating or booking any records', async () => {
  calls = [];
  await assert.rejects(invoke(controller.createAppointmentByReceptionist, {
    body: {patient: {full_name: 'Different Person', mobile_no: '9999999999', age: 25, gender: 'female'}, fk_branch_id: 1, fk_treatment_id: 1, fk_slot_id: 1, appointment_date: '2026-09-20', booking_for: 'SELF'},
    user: {id: 1}, headers: {}, ip: '127.0.0.1',
  }), error => error.statusCode === 409 && /select the existing patient/.test(error.message));
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql.trim(), /^SELECT/);
});
