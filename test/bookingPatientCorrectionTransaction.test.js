const test = require('node:test');
const assert = require('node:assert/strict');
process.env.JWT_SECRET = 'booking-correction-test';
process.env.DB_HOST = '127.0.0.1';
process.env.DB_USER = 'test';
process.env.DB_NAME = 'test';
const db = require('../config/db');
let committed = false;
let rolledBack = false;
let calls = [];
db.withTransaction = async fn => {
    try {
        const result = await fn({ execute: async (sql, params) => {
            calls.push({ sql, params });
            if (sql.includes('FROM master_users')) return [[{ id: 5521, uuid: 'DTH115', full_name: 'Patient DTH115', mobile_no: '7999561623', age: 0, gender: 'other', role: 'PAT', is_active: 1 }]];
            return [[]];
        } });
        committed = true;
        return result;
    } catch (error) {
        rolledBack = true;
        throw error;
    }
};
const { createAppointmentByReceptionist } = require('../controllers/v1/receptionistController');

test('patient corrections and audit remain inside the transaction that fails when booking is invalid', async () => {
    await assert.rejects(new Promise((resolve, reject) => createAppointmentByReceptionist({
        body: { fk_patient_id: 5521, patient_updates: { full_name: 'Correct name', age: 34 }, fk_branch_id: 99999,
            fk_treatment_id: 1, fk_slot_id: 1, appointment_date: '2026-10-20' },
        user: { id: 1, role: 'REC' }, headers: {}, ip: '127.0.0.1',
    }, { status() { return this; }, json: resolve }, reject)), error => error.statusCode === 404);
    assert.equal(committed, false);
    assert.equal(rolledBack, true);
    assert.match(calls[0].sql, /WHERE id = \?[\s\S]*FOR UPDATE/);
    assert.equal(calls.find(call => call.sql.startsWith('UPDATE master_users')).params.at(-1), 5521);
    assert.ok(calls.some(call => call.sql.includes('INSERT INTO log_user_profile_updates')));
    assert.ok(calls.every(call => !call.sql.includes('INSERT INTO master_users') && !call.sql.includes('INSERT INTO tbl_appointments')));
});
