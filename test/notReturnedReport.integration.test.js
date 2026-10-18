const test = require('node:test');
const assert = require('node:assert/strict');

// Connection-local temporary tables shadow real tables; no patient data is modified.
test('not-returned SQL handles returns, families, medicine-only visits and future bookings', { skip: process.env.RUN_NOT_RETURNED_DB_TEST !== '1' }, async t => {
    require('dotenv').config({ quiet: true });
    const mysql = require('mysql2/promise');
    const connection = await mysql.createConnection({ host: process.env.DB_HOST, port: process.env.DB_PORT, user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME });
    t.after(() => connection.end());
    const schemas = {
        tbl_appointments: 'appointment_id INT PRIMARY KEY,fk_patient_id INT,fk_patient_family_member_id INT NULL,fk_branch_id INT,fk_treatment_id INT,appointment_date DATE,is_active INT DEFAULT 1,status VARCHAR(30),reception_status VARCHAR(40),queue_status VARCHAR(30)',
        tbl_consultations: 'id INT PRIMARY KEY,appointment_id INT,workflow_status VARCHAR(40),disease VARCHAR(50),diagnosis VARCHAR(50),follow_up_chain_closed INT DEFAULT 0',
        master_users: 'id INT PRIMARY KEY,uuid VARCHAR(30),full_name VARCHAR(50),mobile_no VARCHAR(20),is_active INT DEFAULT 1',
        tbl_patient_family_members: 'id INT PRIMARY KEY,full_name VARCHAR(50),relationship VARCHAR(30),is_active INT DEFAULT 1',
        master_treatments: 'id INT PRIMARY KEY,treatment_name VARCHAR(50)',
        tbl_pending_followups: 'id INT PRIMARY KEY,parent_appointment_id INT,due_date DATE,status VARCHAR(30)',
        tbl_bills: 'id INT PRIMARY KEY,patient_id INT,fk_branch_id INT,consultation_id INT NULL,appointment_id INT NULL,bill_type VARCHAR(30),status VARCHAR(30),created_at DATETIME',
    };
    for (const [table, columns] of Object.entries(schemas)) await connection.query(`CREATE TEMPORARY TABLE ${table} (${columns})`);
    const shared = require.resolve('../services/reports/shared');
    const report = require.resolve('../services/reports/patient/notReturned');
    const original = require.cache[shared];
    require.cache[shared] = { id: shared, filename: shared, loaded: true, exports: { query: async (sql, params) => (await connection.query(sql, params))[0] } };
    delete require.cache[report];
    t.after(() => { delete require.cache[report]; if (original) require.cache[shared] = original; else delete require.cache[shared]; });
    const { getNotReturnedReport, monthsBefore } = require(report);
    const today = (await getNotReturnedReport({ branchId: 1 })).as_of;
    await connection.query("INSERT INTO master_users (id,uuid,full_name) VALUES (1,'T1','One'),(2,'T2','Returned'),(3,'T3','Primary')");
    await connection.query("INSERT INTO tbl_patient_family_members (id,full_name,relationship) VALUES (7,'Family','Son')");
    await connection.query("INSERT INTO master_treatments VALUES (1,'Follow-up visit')");
    const appointments = [
        [1, 1, null, 1, monthsBefore(today, 1), 'Completed', null],
        [2, 2, null, 1, monthsBefore(today, 4), 'Completed', null],
        [3, 2, null, 1, today, 'Completed', null],
        [4, 3, null, 1, monthsBefore(today, 2), 'Completed', null],
        [5, 3, 7, 1, monthsBefore(today, 3), 'Completed', null],
        [6, 3, 7, 1, today, 'Booked', null],
        [7, 1, null, 2, today, 'Completed', null], // Other branch cannot affect this branch report.
        [8, 1, null, 1, today, 'Cancelled', null],
        [9, 1, null, 1, today, 'Booked', 'REJECTED_BY_RECEPTION'],
    ];
    for (const [id, patient, family, branch, date, status, reception] of appointments) {
        await connection.query('INSERT INTO tbl_appointments (appointment_id,fk_patient_id,fk_patient_family_member_id,fk_branch_id,fk_treatment_id,appointment_date,status,reception_status) VALUES (?,?,?,?,1,?,?,?)', [id, patient, family, branch, date, status, reception]);
        if (status === 'Completed') await connection.query("INSERT INTO tbl_consultations (id,appointment_id,workflow_status) VALUES (?,?,'PROCESSED_BY_MEDICAL')", [id, id]);
    }
    await connection.query("INSERT INTO tbl_pending_followups VALUES (1,1,?,'PENDING'),(2,4,?,'CLOSED_BY_DOCTOR'),(3,5,?,'CONFIRMED_BOOKED')", [monthsBefore(today, 1), today, today]);
    await connection.query("INSERT INTO tbl_bills VALUES (1,3,1,5,NULL,'MEDICATION','ACTIVE',?), (2,1,1,NULL,NULL,'MEDICATION','ACTIVE',?), (3,3,1,5,NULL,'MEDICATION','VOID',?)", [today, today, today]);
    const result = await getNotReturnedReport({ branchId: 1 });
    assert.equal(result.rows.length, 3);
    assert.deepEqual(result.rows.map(row => row.subject_key).sort(), ['FM:7', 'PAT:1', 'PAT:3']);
    const primary = result.rows.find(row => row.subject_key === 'PAT:3');
    const family = result.rows.find(row => row.subject_key === 'FM:7');
    assert.equal(primary.bucket, '2_3');
    assert.equal(primary.last_medicine_date, null);
    assert.equal(primary.due_date, null);
    assert.equal(family.bucket, '3_plus');
    assert.equal(family.last_medicine_date, today);
    assert.equal(family.next_appointment, today);
    assert.equal(family.overdue_days, 0);
    const one = result.rows.find(row => row.subject_key === 'PAT:1');
    assert.equal(one.bucket, '1_2');
    assert.equal(one.last_medicine_date, today);
    assert.equal(one.next_appointment, null);
    assert.ok(one.overdue_days >= 28);
});
