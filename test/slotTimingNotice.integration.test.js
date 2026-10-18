const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { snapshotTimingAppointments, recordTimingNotice, attachTimingNotices } = require('../services/slotTimingNoticeService');

test('timing notice SQL persists shift/reset snapshots and rolls back with the timing transaction', { skip: process.env.RUN_SLOT_NOTICE_DB_TEST !== '1' }, async () => {
    require('dotenv').config({ path: path.join(__dirname, '../.env'), quiet: true });
    const mysql = require('mysql2/promise');
    const connection = await mysql.createConnection({ host: process.env.DB_HOST, port: process.env.DB_PORT, user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME });
    await connection.query('SELECT whatsapp_number FROM master_users LIMIT 0');
    const names = ['tbl_appointments', 'tbl_doctor_slot_time_override_audit_logs'];
    const counts = async () => Promise.all(names.map(async name => { const [r] = await connection.query(`SELECT COUNT(*) AS total FROM ${name}`); return r[0].total; }));
    const original = await counts();
    const context={branchId:1,slotId:2,appointmentDate:'2026-10-20'};
    try {
        await connection.query(`CREATE TEMPORARY TABLE tbl_appointments (appointment_id INT PRIMARY KEY, fk_branch_id INT, fk_slot_id INT, appointment_date DATE, is_active INT, status VARCHAR(30), reception_status VARCHAR(50), queue_status VARCHAR(30), planned_start_at DATETIME)`);
        await connection.query(`CREATE TEMPORARY TABLE tbl_doctor_slot_time_override_audit_logs (id INT AUTO_INCREMENT PRIMARY KEY, fk_branch_id INT, fk_slot_id INT, appointment_date DATE, new_data_json JSON)`);
        for (const name of names) { const [r]=await connection.query(`SHOW CREATE TABLE ${name}`); assert.match(Object.values(r[0]).join(' '),/CREATE TEMPORARY TABLE/i); }
        await connection.query(`INSERT INTO tbl_appointments VALUES (1,1,2,'2026-10-20',1,'Confirmed','PENDING','BOOKED','2026-10-20 18:20:00'),(2,1,2,'2026-10-20',1,'Cancelled','PENDING','CANCELLED','2026-10-20 18:30:00'),(3,2,2,'2026-10-20',1,'Confirmed','PENDING','BOOKED','2026-10-20 18:30:00')`);
        const execute=async(sql,params)=>{ const [rows]=await connection.execute(sql,params);return rows; };
        const readRows=()=>execute(`SELECT *, DATE_FORMAT(appointment_date,'%Y-%m-%d') AS notice_date, DATE_FORMAT(planned_start_at,'%Y-%m-%d %H:%i:%s') AS notice_planned_at FROM tbl_appointments`);
        for (const [oldStart,newStart,newTime] of [['18:00:00','19:00:00','19:20:00'],['19:00:00','18:00:00','18:20:00']]) {
            await connection.beginTransaction();
            const before=await snapshotTimingAppointments(connection,context);
            await connection.execute('UPDATE tbl_appointments SET planned_start_at = ? WHERE appointment_id=1',[`2026-10-20 ${newTime}`]);
            await connection.execute('INSERT INTO tbl_doctor_slot_time_override_audit_logs (fk_branch_id,fk_slot_id,appointment_date,new_data_json) VALUES (1,2,?,?)',[context.appointmentDate,JSON.stringify({original_audit:true})]);
            await recordTimingNotice(connection,{context,before,oldStart,newStart});
            await connection.commit();
            const rows=await attachTimingNotices(execute,await readRows());
            assert.match(rows[0].timing_change.new_planned_at,new RegExp(newTime));
            assert.equal(rows[1].timing_change,null);assert.equal(rows[2].timing_change,null);
        }
        // A patient booked later must not inherit the shift notification.
        await connection.query(`INSERT INTO tbl_appointments VALUES (4,1,2,'2026-10-20',1,'Confirmed','PENDING','BOOKED','2026-10-20 18:40:00')`);
        assert.equal((await attachTimingNotices(execute,await readRows()))[3].timing_change,null);
        // A failed operation leaves neither a partial timing change nor its notice.
        await connection.beginTransaction();
        const before=await snapshotTimingAppointments(connection,context);
        await connection.query(`UPDATE tbl_appointments SET planned_start_at='2026-10-20 20:20:00' WHERE appointment_id=1`);
        await connection.query(`INSERT INTO tbl_doctor_slot_time_override_audit_logs (fk_branch_id,fk_slot_id,appointment_date,new_data_json) VALUES (1,2,'2026-10-20','{}')`);
        await recordTimingNotice(connection,{context,before,oldStart:'18:00:00',newStart:'20:00:00'});
        await connection.rollback();
        const final=await attachTimingNotices(execute,await readRows());
        assert.equal(final[0].timing_change.new_planned_at,'2026-10-20 18:20:00');
    } finally {
        await connection.rollback();
        for (const name of names) await connection.query(`DROP TEMPORARY TABLE IF EXISTS ${name}`);
        assert.deepEqual(await counts(),original,'permanent clinic table counts unchanged');
        await connection.end();
    }
});
