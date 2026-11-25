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
        master_clinic_branches: 'id INT PRIMARY KEY,branch_name VARCHAR(80)',
        master_users: 'id INT PRIMARY KEY,uuid VARCHAR(30),full_name VARCHAR(50),mobile_no VARCHAR(20),is_active INT DEFAULT 1',
        tbl_patient_family_members: 'id INT PRIMARY KEY,full_name VARCHAR(50),relationship VARCHAR(30),is_active INT DEFAULT 1',
        master_treatments: 'id INT PRIMARY KEY,treatment_name VARCHAR(50),treatment_code VARCHAR(50) NULL',
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
    await connection.query("INSERT INTO master_treatments VALUES (1,'Follow-up visit','FOLLOW_UP_VISIT')");
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
    const all = await getNotReturnedReport({ branchIds: [1,2] });
    assert.ok(!all.rows.some(row => row.subject_key === 'PAT:1'), 'Recent return at branch 2 removes the patient from the combined overdue list');
    assert.deepEqual(all.rows.map(row => row.subject_key).sort(), ['FM:7', 'PAT:3']);

    await t.test('acute-only patients are excluded and acute returns or bookings do not reset regular follow-up history', async () => {
        await connection.query("INSERT INTO master_users (id,uuid,full_name) VALUES (4,'T4','Acute only'),(5,'T5','Acute return'),(6,'T6','Future return'),(7,'T7','Legacy acute'),(8,'T8','Other branch acute'),(9,'T9','Online regular')");
        await connection.query("INSERT INTO tbl_patient_family_members (id,full_name,relationship) VALUES (8,'Acute family','Daughter'),(9,'Regular family','Son')");
        await connection.query("INSERT INTO master_treatments VALUES (3,'Renamed urgent visit','ACUTE_TREATMENT'),(4,'Online Consultation','CHRONIC_CASE_DISCUSSION'),(30,'Acute Treatment',NULL)");
        const tomorrow = new Date(Date.parse(`${today}T00:00:00Z`) + 86400000).toISOString().slice(0,10);
        const later = new Date(Date.parse(`${today}T00:00:00Z`) + 2 * 86400000).toISOString().slice(0,10);
        const old = monthsBefore(today, 3);
        const visits = [
            [10,4,null,1,3,old,'Completed'], // Acute-only: persisted code wins despite renamed display.
            [11,5,null,1,1,old,'Completed'],
            [12,5,null,1,3,today,'Completed'], // Recent acute visit cannot hide the regular consultation.
            [13,5,null,1,3,tomorrow,'Booked'], // Acute-only future booking is not a regular return.
            [14,6,null,1,1,old,'Completed'],
            [15,6,null,1,3,tomorrow,'Booked'],
            [16,6,null,1,1,later,'Booked'], // Pick this non-acute booking instead of the earlier acute one.
            [17,7,null,1,30,old,'Completed'], // Legacy name fallback without a code.
            [18,3,8,1,3,old,'Completed'],
            [19,3,9,1,1,old,'Completed'],
            [20,3,9,1,3,today,'Completed'], // Family subjects remain independent of the primary account.
            [21,8,null,1,1,old,'Completed'],
            [22,8,null,2,3,today,'Completed'], // An acute visit at another branch is ignored in all-branch scope too.
            [23,9,null,1,4,old,'Completed'],
            [24,9,null,1,3,today,'Completed'], // Online consultations continue to count.
        ];
        for (const [id,patient,family,branch,treatment,date,status] of visits) {
            await connection.query('INSERT INTO tbl_appointments (appointment_id,fk_patient_id,fk_patient_family_member_id,fk_branch_id,fk_treatment_id,appointment_date,status) VALUES (?,?,?,?,?,?,?)',[id,patient,family,branch,treatment,date,status]);
            if (status==='Completed') await connection.query("INSERT INTO tbl_consultations (id,appointment_id,workflow_status) VALUES (?,?,'PROCESSED_BY_MEDICAL')",[id,id]);
        }
        await connection.query("INSERT INTO tbl_pending_followups VALUES (4,11,?,'PENDING')",[monthsBefore(today,2)]);
        const branch = await getNotReturnedReport({ branchId:1 });
        assert.deepEqual(branch.rows.map(row=>row.subject_key).sort(),['FM:7','FM:9','PAT:1','PAT:3','PAT:5','PAT:6','PAT:8','PAT:9']);
        const returned = branch.rows.find(row=>row.subject_key==='PAT:5');
        assert.equal(returned.appointment_id,11);
        assert.equal(returned.last_visit_date,old);
        assert.equal(returned.bucket,'3_plus');
        assert.equal(returned.due_date,monthsBefore(today,2));
        assert.equal(returned.next_appointment,null);
        assert.equal(branch.rows.find(row=>row.subject_key==='PAT:6').next_appointment,later);
        assert.equal(branch.rows.find(row=>row.subject_key==='FM:9').appointment_id,19);
        assert.equal(branch.rows.find(row=>row.subject_key==='PAT:9').appointment_id,23);
        const combined = await getNotReturnedReport({ branchIds:[1,2] });
        assert.ok(combined.rows.some(row=>row.subject_key==='PAT:8'&&row.appointment_id===21));
        assert.ok(!combined.rows.some(row=>row.subject_key==='PAT:1'));
        assert.ok(!combined.rows.some(row=>['PAT:4','PAT:7','FM:8'].includes(row.subject_key)));
    });
});
