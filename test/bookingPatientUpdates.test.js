const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeBookingPatientUpdates, saveBookingPatientUpdates } = require('../utils/bookingPatientUpdates');
const patient = { id: 5521, uuid: 'DTH115', full_name: 'Patient DTH115', mobile_no: '7999561623', age: 0, gender: 'other' };
const actor = { id: 1, role: 'REC', ip: '127.0.0.1', userAgent: 'test' };

test('corrections require an existing account and cannot replace internal ID or registration number', () => {
    assert.deepEqual(normalizeBookingPatientUpdates(undefined, null), {});
    for (const updates of [{ uuid: 'DTH2' }, { id: 2 }, { age: 0 }, { age: 121 }, { gender: 'invalid' }, { mobile_no: '123' }, { full_name: '' }, []]) {
        assert.throws(() => normalizeBookingPatientUpdates(updates, 5521), error => error.statusCode === 400);
    }
    assert.throws(() => normalizeBookingPatientUpdates({ full_name: 'Correct name' }, null), error => error.statusCode === 400);
});

test('corrections update and audit the same patient without inserting a new account or changing UUID', async () => {
    const calls = [];
    const connection = { execute: async (sql, params) => { calls.push({ sql, params }); return [[]]; } };
    const updates = normalizeBookingPatientUpdates({ full_name: ' Correct name ', age: '34', gender: 'FEMALE' }, patient.id);
    await saveBookingPatientUpdates(connection, patient, updates, actor);
    assert.equal(calls.length, 2);
    assert.match(calls[0].sql, /^UPDATE master_users SET full_name = \?, age = \?, gender = \?/);
    assert.equal(calls[0].params.at(-1), 5521);
    assert.doesNotMatch(calls[0].sql, /uuid|INSERT/);
    assert.match(calls[1].sql, /INSERT INTO log_user_profile_updates/);
    assert.equal(calls[1].params[0], 5521);
    assert.deepEqual(JSON.parse(calls[1].params[7]), { full_name: 'Correct name', age: 34, gender: 'female' });
});

test('duplicate phone rejects before any write, including another inactive or staff account', async () => {
    const calls = [];
    const connection = { execute: async (sql, params) => { calls.push({ sql, params }); return [[{ id: 99 }]]; } };
    await assert.rejects(saveBookingPatientUpdates(connection, patient, { mobile_no: '9999999999' }, actor), error => error.statusCode === 409);
    assert.equal(calls.length, 1);
    assert.doesNotMatch(calls[0].sql, /is_active|role|UPDATE master_users/);
    assert.deepEqual(calls[0].params, ['9999999999', 5521]);
});

test('unchanged existing details including imported zero age need no writes', async () => {
    await saveBookingPatientUpdates({ execute: async () => { throw new Error('Unexpected write'); } }, patient,
        { full_name: patient.full_name, age: 0, mobile_no: patient.mobile_no, gender: patient.gender }, actor);
});
