const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadHandler(calls) {
    const source = fs.readFileSync(path.join(__dirname, '../controllers/v1/receptionistController.js'), 'utf8');
    const start = source.indexOf('const updateReceptionistPatient =');
    const end = source.indexOf('const listReceptionistPatientUpdateHistory =', start);
    const patient = { id: 7, uuid: 'DTH7', role: 'PAT', is_active: 1, age: 30 };
    const connection = {
        execute: async (sql, values) => {
            calls.push({ sql, values });
            if (sql.includes('FROM tbl_appointments')) return [[{ appointment_id: 1 }]];
            if (sql.includes('SELECT id, uuid')) return [[patient]];
            if (sql.includes('SELECT id AS patient_id')) return [[{ patient_id: 7, age: 31 }]];
            return [{ affectedRows: 1 }];
        },
    };
    class AppError extends Error {
        constructor(message, status) { super(message); this.status = status; }
    }
    return vm.runInNewContext(`${source.slice(start, end)}; updateReceptionistPatient`, {
        asyncHandler: (handler) => handler,
        AppError,
        toPositiveInt: (value) => Number.isInteger(Number(value)) && Number(value) > 0 ? Number(value) : null,
        validateGender: () => true,
        validateMobile: () => true,
        getClientIp: () => '127.0.0.1',
        PATIENT_ROLE: 'PAT',
        withTransaction: (handler) => handler(connection),
    });
}

const request = (age) => ({ params: { patient_id: '7' }, body: { age }, selectedBranchId: 1, user: { id: 2, role: 'REC' }, headers: {} });

test('reception can correct primary patient age alone and audit old/new values', async () => {
    const calls = [];
    let response;
    const res = { status: () => res, json: (value) => { response = value; } };
    await loadHandler(calls)(request(31), res);
    const update = calls.find(({ sql }) => sql.includes('UPDATE master_users'));
    assert.match(update.sql, /age = \?/);
    assert.equal(update.values[0], 31);
    const audit = calls.find(({ sql }) => sql.includes('INSERT INTO log_user_profile_updates'));
    assert.deepEqual(JSON.parse(audit.values[5]), ['age']);
    assert.deepEqual(JSON.parse(audit.values[6]), { age: 30 });
    assert.deepEqual(JSON.parse(audit.values[7]), { age: 31 });
    assert.equal(response.data.patient.age, 31);
});

test('invalid primary patient ages are rejected before database writes', async () => {
    for (const age of [0, 121, 1.5, '', 'invalid']) {
        const calls = [];
        await assert.rejects(loadHandler(calls)(request(age), {}), /age must be between 1 and 120/);
        assert.equal(calls.length, 0);
    }
});
