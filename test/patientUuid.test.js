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
            if (sql.includes('MAX(CAST(SUBSTRING(REPLACE(uuid')) {
                return [[{ last_serial: lastSerial }]];
            }
            if (sql.includes('RELEASE_LOCK')) {
                return [[]];
            }
            throw new Error(`Unexpected SQL: ${sql}`);
        },
    };
};

test('first patient uuid starts at DTH_9990 when no DTH rows exist', async () => {
    const connection = createFakeConnection({ lastSerial: null });
    const uuid = await generatePatientUuid(connection);
    assert.equal(uuid, buildPatientUuid(PATIENT_UUID_FIRST_SERIAL));
    assert.equal(uuid, 'DTH_9990');
});

test('next patient uuid increments the highest existing serial numerically', async () => {
    const connection = createFakeConnection({ lastSerial: 99999 });
    const uuid = await generatePatientUuid(connection);
    assert.equal(uuid, 'DTH_100000');
});

test('serial never drops below the configured start even if lower DTH rows exist', async () => {
    const connection = createFakeConnection({ lastSerial: 42 });
    const uuid = await generatePatientUuid(connection);
    assert.equal(uuid, 'DTH_9990');
});

test('lock is always released and the read is a locking read on the DTH prefix', async () => {
    const connection = createFakeConnection({ lastSerial: 10004 });
    const uuid = await generatePatientUuid(connection);
    assert.equal(uuid, 'DTH_10005');

    const sqls = connection.calls.map((call) => call.sql);
    assert.ok(sqls[0].includes('GET_LOCK'));
    assert.ok(sqls[1].includes('FOR UPDATE'));
    assert.deepEqual(connection.calls[1].params, ['^DTH_?[0-9]+$']);
    assert.match(connection.calls[1].sql, /REPLACE\(uuid, '_', ''\)/);
    assert.ok(sqls[sqls.length - 1].includes('RELEASE_LOCK'));
});

test('existing Excel registration 9989 continues at DTH_9990', async () => {
    assert.equal(await generatePatientUuid(createFakeConnection({ lastSerial: 9989 })), 'DTH_9990');
    assert.equal(await generatePatientUuid(createFakeConnection({ lastSerial: 9990 })), 'DTH_9991');
});

test('fails with 503 when the sequence lock cannot be acquired', async () => {
    const connection = createFakeConnection({ lastSerial: 10004, lockAcquired: 0 });
    await assert.rejects(() => generatePatientUuid(connection), (error) => error.statusCode === 503);
});
