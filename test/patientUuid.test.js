const test = require('node:test');
const assert = require('node:assert/strict');

const {
    PATIENT_UUID_PREFIX,
    PATIENT_UUID_FIRST_SERIAL,
    buildPatientUuid,
    generatePatientUuid,
} = require('../utils/patientUuid');

const createFakeConnection = ({ lastSerial, lockAcquired = 1 }) => {
    const calls = [];
    return {
        calls,
        async execute(sql, params) {
            calls.push({ sql, params });
            if (sql.includes('GET_LOCK')) {
                return [[{ acquired_lock: lockAcquired }]];
            }
            if (sql.includes('MAX(CAST(SUBSTRING(uuid')) {
                return [[{ last_serial: lastSerial }]];
            }
            if (sql.includes('RELEASE_LOCK')) {
                return [[]];
            }
            throw new Error(`Unexpected SQL: ${sql}`);
        },
    };
};

test('first patient uuid starts at DTH10000 when no DTH rows exist', async () => {
    const connection = createFakeConnection({ lastSerial: null });
    const uuid = await generatePatientUuid(connection);
    assert.equal(uuid, buildPatientUuid(PATIENT_UUID_FIRST_SERIAL));
    assert.equal(uuid, 'DTH10000');
});

test('next patient uuid increments the highest existing serial numerically', async () => {
    const connection = createFakeConnection({ lastSerial: 99999 });
    const uuid = await generatePatientUuid(connection);
    assert.equal(uuid, 'DTH100000');
});

test('serial never drops below the configured start even if lower DTH rows exist', async () => {
    const connection = createFakeConnection({ lastSerial: 42 });
    const uuid = await generatePatientUuid(connection);
    assert.equal(uuid, 'DTH10000');
});

test('lock is always released and the read is a locking read on the DTH prefix', async () => {
    const connection = createFakeConnection({ lastSerial: 10004 });
    const uuid = await generatePatientUuid(connection);
    assert.equal(uuid, 'DTH10005');

    const sqls = connection.calls.map((call) => call.sql);
    assert.ok(sqls[0].includes('GET_LOCK'));
    assert.ok(sqls[1].includes('FOR UPDATE'));
    assert.deepEqual(connection.calls[1].params, [PATIENT_UUID_PREFIX.length + 1, `${PATIENT_UUID_PREFIX}%`]);
    assert.ok(sqls[sqls.length - 1].includes('RELEASE_LOCK'));
});

test('fails with 503 when the sequence lock cannot be acquired', async () => {
    const connection = createFakeConnection({ lastSerial: 10004, lockAcquired: 0 });
    await assert.rejects(() => generatePatientUuid(connection), (error) => error.statusCode === 503);
});
