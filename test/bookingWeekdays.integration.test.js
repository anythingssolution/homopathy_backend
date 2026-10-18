const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
test('weekday schedule: isolated DB save, defaults, leave, access, stale edits and migration rerun', {skip:process.env.RUN_BOOKING_WEEKDAYS_DB_TEST!=='1'}, async t => {
    require('dotenv').config();
    const mysql = require('mysql2/promise');
    const db = await mysql.createConnection({host:process.env.DB_HOST,port:process.env.DB_PORT,user:process.env.DB_USER,password:process.env.DB_PASSWORD,database:process.env.DB_NAME});
    const baseline = (await db.query('SELECT fk_slot_id,day_of_week,booking_enabled,updated_by FROM tbl_branch_slot_booking_weekdays ORDER BY fk_slot_id,day_of_week'))[0];
    t.after(async () => {
        try {
            await db.query('DROP TEMPORARY TABLE IF EXISTS tbl_branch_slot_booking_weekdays');
            assert.deepEqual((await db.query('SELECT fk_slot_id,day_of_week,booking_enabled,updated_by FROM tbl_branch_slot_booking_weekdays ORDER BY fk_slot_id,day_of_week'))[0], baseline);
        } finally { await db.end(); }
    });
    for(const [name, schema] of Object.entries({
        master_clinic_branches: 'id BIGINT UNSIGNED PRIMARY KEY,branch_name VARCHAR(80),is_active INT',
        master_slots: 'id BIGINT UNSIGNED PRIMARY KEY,fk_branch_id BIGINT UNSIGNED,slot_name VARCHAR(80),start_time TIME,end_time TIME,is_active INT',
        tbl_user_branch_access: 'user_id INT,branch_id BIGINT UNSIGNED,is_active INT',
        tbl_branch_recurring_schedule_rules: 'id INT,fk_branch_id BIGINT UNSIGNED,fk_slot_id BIGINT UNSIGNED NULL,day_of_week INT,override_start_time TIME,is_active INT',
        tbl_branch_doctor_leaves: 'fk_branch_id BIGINT UNSIGNED,leave_date DATE,status VARCHAR(20)',
    })) await db.query(`CREATE TEMPORARY TABLE ${name} (${schema}) ENGINE=InnoDB`);
    const migration = fs.readFileSync(path.join(__dirname,'../sql/migrations/2026-10-17_001_booking_weekdays.sql'),'utf8').replace('CREATE TABLE IF NOT EXISTS tbl_', 'CREATE TEMPORARY TABLE IF NOT EXISTS tbl_');
    await db.query(migration);
    const definition = (await db.query('SHOW CREATE TABLE tbl_branch_slot_booking_weekdays'))[0][0];
    assert.match(Object.values(definition).join(' '), /CREATE TEMPORARY TABLE/);
    await db.query("INSERT INTO master_clinic_branches VALUES(1,'Lily Chowk',1),(2,'Pandri',1),(3,'Inactive',0)");
    await db.query("INSERT INTO master_slots VALUES(1,1,'Morning','11:00','14:30',1),(2,1,'Evening','18:00','21:00',1),(3,2,'Morning','11:30','17:30',1),(4,3,'Inactive','11:30','17:30',1)");
    await db.query('INSERT INTO tbl_user_branch_access VALUES(9,1,1),(9,2,1),(10,1,1),(10,2,0)');
    const source = path.join(__dirname,'../services/bookingWeekdayService.js');
    const mockDb = {query:async(sql,params)=>(await db.query(sql,params))[0],withTransaction:async handler=>{await db.beginTransaction();try{const result=await handler(db);await db.commit();return result;}catch(e){await db.rollback();throw e;}}};
    const moduleRef = {exports:{}};
    vm.runInNewContext(fs.readFileSync(source,'utf8'),{module:moduleRef,require:name=>name==='../config/db'?mockDb:name==='../utils/AppError'?require('../utils/AppError'):name==='./slotTimeOverrideService'?{DAY_OF_WEEK_LABELS:['','Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'],getDayOfWeekForDate:d=>new Date(d+'T00:00:00Z').getUTCDay()+1}:require(name)});
    const service = moduleRef.exports;
    const original = await service.getDoctorBookingWeekdays(9);
    assert.equal(original.slots.length,3); assert.ok(original.slots.every(s=>s.weekdays.every(d=>d.booking_enabled)));
    const changes = original.slots.flatMap(s=>s.weekdays.map(d=>({slot_id:Number(s.slot_id),day_of_week:d.day_of_week,booking_enabled:s.slot_id===3?d.day_of_week===3:d.day_of_week!==3})));
    const saved = await service.saveDoctorBookingWeekdays({doctorId:9,revision:original.revision,changes});
    assert.notEqual(saved.revision,original.revision);
    assert.equal((await service.getDoctorBookingWeekdays(9)).revision,saved.revision);
    let date = await service.getDateBookingAvailability('2026-10-20');
    assert.equal(date.branches.find(b=>b.branch_id===2).booking_enabled,true);
    assert.equal(date.branches.find(b=>b.branch_id===1).booking_enabled,false);
    await assert.rejects(service.assertWeeklyBookingOpen({branchId:2,slotId:3,appointmentDate:'2026-10-19',executor:mockDb.query}),{statusCode:409});
    await assert.doesNotReject(service.assertWeeklyBookingOpen({branchId:2,slotId:3,appointmentDate:'2026-10-20',executor:mockDb.query}));
    await db.query("INSERT INTO tbl_branch_doctor_leaves VALUES(2,'2026-10-20','ACTIVE')");
    date = await service.getDateBookingAvailability('2026-10-20');
    assert.equal(date.branches.find(b=>b.branch_id===2).booking_enabled,false);
    assert.match(date.branches.find(b=>b.branch_id===2).reason,/leave/);
    await assert.rejects(service.saveDoctorBookingWeekdays({doctorId:9,revision:original.revision,changes}),{statusCode:409});
    await assert.rejects(service.saveDoctorBookingWeekdays({doctorId:10,revision:saved.revision,changes}),{statusCode:400});
    assert.equal((await service.getDoctorBookingWeekdays(9)).revision,saved.revision);
    const closed = await service.saveDoctorBookingWeekdays({doctorId:9,revision:saved.revision,changes:changes.map(row=>({...row,booking_enabled:false}))});
    assert.ok(closed.slots.every(s=>s.weekdays.every(d=>!d.booking_enabled)));
    await db.query(migration);
    assert.equal((await db.query('SELECT COUNT(*) n FROM tbl_branch_slot_booking_weekdays'))[0][0].n,21);
    assert.equal((await db.query('SELECT start_time FROM master_slots WHERE id=3'))[0][0].start_time,'11:30:00');
    await assert.rejects(db.query('INSERT INTO tbl_branch_slot_booking_weekdays(fk_slot_id,day_of_week) VALUES(3,3)'),{code:'ER_DUP_ENTRY'});
});
