const test = require('node:test');
const assert = require('node:assert/strict');

test('patient summaries deduplicate branch membership and include unlinked registrations only in full-access All Branches', { skip: process.env.RUN_REPORT_BRANCH_DB_TEST !== '1' }, async t => {
    require('dotenv').config({ quiet: true });
    const mysql = require('mysql2/promise');
    const db = await mysql.createConnection({ host: process.env.DB_HOST, port: process.env.DB_PORT, user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME });
    t.after(() => db.end());
    const schemas = {
        master_users: 'id INT PRIMARY KEY,full_name VARCHAR(50),uuid VARCHAR(20),mobile_no VARCHAR(20),email VARCHAR(30),age INT,date_of_birth DATE,is_active INT,role VARCHAR(5),created_at DATETIME',
        tbl_patient_family_members: 'id INT PRIMARY KEY,fk_primary_patient_id INT,is_active INT',
        tbl_appointments: 'appointment_id INT PRIMARY KEY,fk_patient_id INT,fk_branch_id INT,is_active INT',
        tbl_bills: 'id INT PRIMARY KEY,patient_id INT,fk_branch_id INT',
    };
    for (const [name, schema] of Object.entries(schemas)) await db.query(`CREATE TEMPORARY TABLE ${name} (${schema})`);
    for (let id=1; id<=5; id++) await db.query("INSERT INTO master_users VALUES (?,?,?,NULL,NULL,30,NULL,1,'PAT','2026-11-01')", [id,`Patient ${id}`,`REG${id}`]);
    await db.query('INSERT INTO tbl_appointments VALUES (1,1,1,1),(2,1,1,1),(3,1,2,1),(4,2,2,1),(5,4,3,1)');
    await db.query('INSERT INTO tbl_bills VALUES (1,5,1)');
    await db.query('INSERT INTO tbl_patient_family_members VALUES (1,1,1),(2,1,1)');
    const shared = require.resolve('../services/reports/shared'), service = require.resolve('../services/reports/patient/summary');
    const before = require.cache[shared], previous = require.cache[service];
    const { buildDateRangeScope, buildTimestampDateRangeScope } = require('../services/reports/shared');
    require.cache[shared] = { id: shared, filename: shared, loaded: true, exports: { buildDateRangeScope, buildTimestampDateRangeScope, query: async (sql, params) => (await db.query(sql, params))[0] } };
    delete require.cache[service]; delete require.cache[require.resolve('../services/reports/patient/shared')];
    t.after(() => { delete require.cache[require.resolve('../services/reports/patient/shared')]; if (before) require.cache[shared]=before; else delete require.cache[shared]; if(previous)require.cache[service]=previous;else delete require.cache[service]; });
    const summary = require(service);
    const scope = { fromDate:'2026-11-01',toDate:'2026-11-20' };
    const count = async filters => Number((await summary({ ...scope, ...filters }))[0].active_primary_patients);
    assert.equal(await count({ branchIds:[1] }),2);
    assert.equal(await count({ branchIds:[2] }),2);
    assert.equal(await count({ branchIds:[1,2] }),3);
    assert.equal(await count({ branchIds:[1,2,3],allClinicBranches:true }),5);
    assert.equal(await count({ branchIds:[] }),0);
    assert.equal(await count({ branchId:1 }),5, 'legacy registration reports retain their original account-wide behavior');
});
