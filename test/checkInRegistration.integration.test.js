const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

test('DTH database concurrency, P1/P3 order, rollback, retry and existing ID preservation', {
    skip: process.env.RUN_DTH_CHECKIN_DB_TEST !== '1',
}, async () => {
    require('dotenv').config();
    const mysql = require('mysql2/promise');
    const suffix = `${Date.now()}_${process.pid}`;
    const users = `codex_dth_users_${suffix}`, sequence = `codex_dth_sequence_${suffix}`;
    const options = { host: process.env.DB_HOST, port: process.env.DB_PORT, user: process.env.DB_USER,
        password: process.env.DB_PASSWORD, database: process.env.DB_NAME };
    const a = await mysql.createConnection(options), b = await mysql.createConnection(options);
    try {
        await a.query(`CREATE TABLE ${users} (id INT PRIMARY KEY, uuid CHAR(36) NULL UNIQUE, role VARCHAR(10) NOT NULL) ENGINE=InnoDB`);
        await a.query(`CREATE TABLE ${sequence} (id INT PRIMARY KEY,last_serial BIGINT UNSIGNED NOT NULL) ENGINE=InnoDB`);
        await a.query(`INSERT INTO ${sequence} VALUES (1,2020)`);
        await a.query(`INSERT INTO ${users} VALUES (1,NULL,'PAT'),(2,NULL,'PAT'),(3,NULL,'PAT'),(4,NULL,'PAT'),(5,NULL,'PAT'),(90,'DTH2020','PAT')`);
        const source = fs.readFileSync(require.resolve('../utils/patientUuid'), 'utf8')
            .replaceAll('master_users', users).replaceAll('tbl_patient_registration_sequence', sequence);
        const module = { exports: {} };
        vm.runInNewContext(source, { module, require: () => require('../utils/AppError') });
        const assign = module.exports.ensurePatientRegistration;

        await a.beginTransaction();
        assert.equal(await assign(a, 1), 'DTH_2021');
        await b.beginTransaction();
        const p3 = assign(b, 3);
        await a.commit();
        assert.equal(await p3, 'DTH_2022');
        await b.commit();
        const [[p2]] = await a.query(`SELECT uuid FROM ${users} WHERE id=2`);
        assert.equal(p2.uuid, null);
        await a.beginTransaction();
        assert.equal(await assign(a, 2), 'DTH_2023');
        await a.commit();

        await a.beginTransaction();
        assert.equal(await assign(a, 4), 'DTH_2024');
        await b.beginTransaction();
        const duplicateClick = assign(b, 4);
        await a.commit();
        assert.equal(await duplicateClick, 'DTH_2024');
        await b.commit();

        await a.beginTransaction();
        assert.equal(await assign(a, 5), 'DTH_2025');
        await a.rollback();
        await b.beginTransaction();
        assert.equal(await assign(b, 5), 'DTH_2025');
        assert.equal(await assign(b, 90), 'DTH2020');
        await b.commit();
        const [[count]] = await a.query(`SELECT COUNT(*) total,COUNT(DISTINCT uuid) unique_numbers FROM ${users}`);
        assert.equal(count.total, count.unique_numbers);
        const [[counter]] = await a.query(`SELECT last_serial FROM ${sequence}`);
        assert.equal(Number(counter.last_serial), 2025);
    } finally {
        await a.rollback(); await b.rollback();
        await a.query(`DROP TABLE IF EXISTS ${users}`);
        await a.query(`DROP TABLE IF EXISTS ${sequence}`);
        await a.end(); await b.end();
    }
});
