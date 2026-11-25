const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

test('check-in source recovery isolates branch/operator, preserves subjects and survives reload without changing attendance', {
    skip: process.env.RUN_RECEPTION_SOURCE_DB_TEST !== '1',
}, async () => {
    require('dotenv').config();
    const mysql = require('mysql2/promise');
    const connection = await mysql.createConnection({ host: process.env.DB_HOST, port: process.env.DB_PORT,
        user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME });
    const prefix = `codex_source_${Date.now()}_${process.pid}`;
    const tables = { tbl_appointments: `${prefix}_appointments`, tbl_appointment_queue_events: `${prefix}_events`,
        tbl_patient_discovery_sources: `${prefix}_answers` };
    const query = async (sql, params) => {
        for (const [original, fixture] of Object.entries(tables)) sql = sql.replaceAll(original, fixture);
        const [rows] = await connection.query(sql, params);
        return rows;
    };
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(require.resolve('../services/patientDiscoverySourceService'), 'utf8'), {
        module, require: name => name === '../config/db' ? { query }
            : name === '../utils/AppError' ? require('../utils/AppError') : require('../utils/reportBranchSql'),
    });
    const service = module.exports;
    const pending = async (actor = 42, branch = 1) => (await service.getPendingReceptionCheckInSource(actor, branch))?.appointment_id ?? null;
    const addAppointment = async (id, { patient = id, family = null, branch = 1, checkedIn = true, active = 1, status = 'Approved' } = {}) => {
        // The booker is deliberately different from the check-in operator.
        await query('INSERT INTO tbl_appointments VALUES (?,?,?,?,99,?,?,?)', [id, patient, family, branch, checkedIn ? '2026-11-25 10:00:00' : null, active, status]);
    };
    const addEvent = (id, actor = 42, meta = '{"patient_source_collection":"CHECK_IN"}') =>
        query("INSERT INTO tbl_appointment_queue_events (appointment_id,event_type,created_by,meta_json) VALUES (?,'CHECKED_IN',?,?)", [id, actor, meta]);
    try {
        // Isolated disposable fixtures: never insert or update clinic tables.
        await query('CREATE TABLE tbl_appointments (appointment_id BIGINT PRIMARY KEY, fk_patient_id BIGINT, fk_patient_family_member_id BIGINT NULL, fk_branch_id BIGINT, booked_by_user_id BIGINT, checked_in_at DATETIME NULL, is_active TINYINT, status VARCHAR(30)) ENGINE=InnoDB');
        await query('CREATE TABLE tbl_appointment_queue_events (id BIGINT AUTO_INCREMENT PRIMARY KEY, appointment_id BIGINT, event_type VARCHAR(100), created_by BIGINT, meta_json TEXT, KEY appointment_event (appointment_id,event_type)) ENGINE=InnoDB');
        await query('CREATE TABLE tbl_patient_discovery_sources (subject_key VARCHAR(80) PRIMARY KEY, patient_id BIGINT, family_member_id BIGINT NULL, appointment_id BIGINT, source_code VARCHAR(30), other_detail VARCHAR(255) NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP) ENGINE=InnoDB');

        await addAppointment(1, { checkedIn: false }); // booking only
        await addAppointment(2); await addEvent(2, 42, '{}'); // historical, unmarked
        await addAppointment(3, { branch: 2 }); await addEvent(3);
        await addAppointment(4); await addEvent(4, 43);
        await addAppointment(5, { checkedIn: false }); await addEvent(5); // undo
        await addAppointment(6, { status: 'Cancelled' }); await addEvent(6);
        await addAppointment(7, { active: 0 }); await addEvent(7);
        await addAppointment(8); await addEvent(8, 42, 'malformed-json');
        await addAppointment(9, { patient: 100 }); await addEvent(9);
        await service.saveStaffSource(9, { source_code: 'GOOGLE' });
        assert.equal(await pending(), null);
        assert.equal(await pending(42, 2), 3);
        assert.equal(await pending(43, 1), 4);

        await addAppointment(10, { patient: 100, family: 20 }); await addEvent(10);
        await addAppointment(11, { patient: 100, family: 20 }); await addEvent(11);
        await addAppointment(12, { patient: 100, family: 21 }); await addEvent(12);
        const before = await query('SELECT * FROM tbl_appointments ORDER BY appointment_id');
        assert.equal(await pending(), 10); // Self answer does not hide family source.
        assert.equal(await pending(), 10); // A new request/reload recovers the same visit.
        await assert.rejects(service.saveStaffSource(10, { source_code: 'OTHER', other_detail: ' ' }), error => error.statusCode === 400);
        assert.equal(await pending(), 10);
        await service.saveStaffSource(10, { source_code: 'OTHER', other_detail: ' Clinic board ' });
        assert.equal(await pending(), 12); // Both visits for member 20 now skip.
        assert.equal((await service.getStaffSource(11)).other_detail, 'Clinic board');
        assert.equal((await service.saveStaffSource(11, { source_code: 'FACEBOOK' })).source_code, 'OTHER');
        assert.equal((await service.getStaffSource(9)).source_code, 'GOOGLE');
        await service.saveStaffSource(12, { source_code: 'YOUTUBE' });
        assert.equal(await pending(), null);
        assert.deepEqual(await query('SELECT * FROM tbl_appointments ORDER BY appointment_id'), before);

        await addAppointment(13); await addEvent(13); await addEvent(13, 44);
        assert.equal(await pending(), null); // Latest check-in belongs to a different operator.
        assert.equal(await pending(44), 13);
        await query('UPDATE tbl_appointments SET checked_in_at=NULL WHERE appointment_id=13');
        assert.equal(await pending(44), null);
    } finally {
        for (const table of Object.values(tables).reverse()) await connection.query(`DROP TABLE IF EXISTS ${table}`);
        await connection.end();
    }
});
