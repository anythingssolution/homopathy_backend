const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const AppError = require('../utils/AppError');
const { ensurePatientRegistration } = require('../utils/patientUuid');
const source = fs.readFileSync(require.resolve('../controllers/v1/liveQueueController'), 'utf8');
const definition = name => {
    const start = source.indexOf(`const ${name} =`);
    const next = source.indexOf('\nconst ', start + 7);
    return source.slice(start, next < 0 ? source.length : next);
};
const loadHandlers = globals => vm.runInNewContext([
    definition('mutateQueueAppointment'), definition('startConsultation'), definition('completeConsultation'),
    '({ startConsultation, completeConsultation })',
].join('\n'), globals);

// Execute the actual shared appointment loader, start/complete handlers and DTH
// allocator together. The fixture returns ONLY columns selected by production SQL.
function fixture({ uuid = 'DTH123', queueStatus = 'CHECKED_IN', failProjection = false, paused = false, otherRunning = false } = {}) {
    let state = {
        appointment: { appointment_id: 7, fk_patient_id: 9, fk_branch_id: 1, fk_slot_id: 1,
            appointment_date: '2026-11-01', current_token_number: 12, queue_status: queueStatus,
            status: 'Pending', is_active: 1, checked_in_at: '2026-11-01 11:00:00', arrival_sequence: 1,
            planned_start_at: null },
        uuid, serial: 2020, sessionCurrent: null, events: [],
    };
    const effects = [], queries = [];
    const connection = { execute: async (sql, params = []) => {
        queries.push(sql);
        assert(!params.includes(undefined), 'production SQL must never bind undefined');
        assert.equal((sql.match(/\?/g) || []).length, params.length);
        if (sql.includes('SELECT fk_branch_id, fk_slot_id, appointment_date')) return [[state.appointment]];
        if (/SELECT appointment_id, fk_patient_id/.test(sql)) {
            const fields = sql.match(/SELECT\s+([\s\S]*?)\s+FROM/)[1].split(',').map(v => v.trim());
            return [[Object.fromEntries(fields.map(field => [field, state.appointment[field]]))]];
        }
        if (sql.includes('SELECT id, uuid')) return [[{ id: 9, uuid: state.uuid }]];
        if (sql.includes('SELECT last_serial')) return [[{ last_serial: state.serial }]];
        if (sql.includes('UPDATE tbl_patient_registration_sequence')) { state.serial = Number(params[0]); return [{ affectedRows: 1 }]; }
        if (sql.includes('UPDATE master_users')) { state.uuid = params[0]; return [{ affectedRows: 1 }]; }
        if (sql.includes('UPDATE tbl_appointments')) { state.appointment.queue_status = params[0]; return [{ affectedRows: 1 }]; }
        if (sql.includes('UPDATE tbl_live_queue_sessions')) {
            state.sessionCurrent = sql.includes('current_appointment_id = NULL') ? null : params[0];
            return [{ affectedRows: 1 }];
        }
        if (sql.includes('SELECT appointment_id, current_token_number')) return [otherRunning ? [{ appointment_id: 8 }] : []];
        if (sql.includes('SELECT appointment_id')) return [[{ appointment_id: 8 }]];
        throw new Error(`Unexpected SQL: ${sql}`);
    }};
    const globals = {
        asyncHandler: fn => fn, AppError, toPositiveInt: Number,
        QUEUE_STATUS: { BOOKED: 'BOOKED', CHECKED_IN: 'CHECKED_IN', WAITING: 'WAITING', IN_PROGRESS: 'IN_PROGRESS', COMPLETED: 'COMPLETED' },
        SESSION_STATUS: { COMPLETED: 'COMPLETED' }, ACTIVE_QUEUE_STATUSES: ['BOOKED','CHECKED_IN','WAITING','IN_PROGRESS'],
        withTransaction: async fn => {
            const before = structuredClone(state);
            try { return await fn(connection); } catch (e) { state = before; throw e; }
        },
        ensurePatientRegistration, getActorUserId: () => 1, getClientIp: () => '127.0.0.1',
        getNextArrivalSequence: async () => 2, ensureQueueSession: async () => {},
        assertQueueSessionCanAdvance: async () => { if (paused) throw new AppError('Queue is paused', 409); },
        recalculateLiveRuntimeProjection: async () => { if (failProjection) throw new Error('Projection failed'); },
        logQueueEvent: async (_, event) => state.events.push(event.eventType),
        cancelScheduledAutoCallNext: async () => effects.push('cancel'),
        scheduleAutoCallNext: async () => { effects.push('schedule'); return null; },
        DEFAULT_AUTO_CALL_DELAY_MS: 0, formatDateTimeForSql: value => value,
        emitLiveQueueEvent: async payload => { effects.push('emit'); return payload; },
    };
    const handlers = loadHandlers(globals);
    return { state: () => state, effects, queries, run: async name => {
        let response;
        await handlers[name]({ params: { appointment_id: 7 }, user: { id: 1 }, headers: {} }, {
            status() { return this; }, json(value) { response = value; },
        });
        return response;
    }};
}

for (const uuid of ['DTH123', null]) {
    test(`actual Start -> Complete flow with ${uuid ? 'existing' : 'pending'} DTH`, async () => {
        const f = fixture({ uuid });
        assert.equal((await f.run('startConsultation')).success, true);
        assert.equal(f.state().appointment.queue_status, 'IN_PROGRESS');
        assert.equal(f.state().sessionCurrent, 7);
        assert.equal(f.state().uuid, uuid || 'DTH_2021');
        assert.equal((await f.run('completeConsultation')).success, true);
        assert.equal(f.state().appointment.queue_status, 'COMPLETED');
        assert.equal(f.state().uuid, uuid || 'DTH_2021');
        assert.equal(f.state().serial, uuid ? 2020 : 2021);
        assert.deepEqual(f.state().events, ['CONSULTATION_STARTED', 'CONSULTATION_COMPLETED']);
        assert.deepEqual(f.effects, ['cancel', 'emit', 'schedule', 'emit']);
    });
}
test('direct Complete from WAITING has the patient ID and assigns DTH only once', async () => {
    const f = fixture({ uuid: null, queueStatus: 'WAITING' });
    assert.equal((await f.run('completeConsultation')).success, true);
    assert.equal(f.state().uuid, 'DTH_2021');
    assert.equal(f.state().serial, 2021);
});
test('failed Start rolls back new DTH, counter and queue updates without broadcasting', async () => {
    const f = fixture({ uuid: null, failProjection: true });
    await assert.rejects(f.run('startConsultation'), /Projection failed/);
    assert.equal(f.state().uuid, null);
    assert.equal(f.state().serial, 2020);
    assert.equal(f.state().appointment.queue_status, 'CHECKED_IN');
    assert.deepEqual(f.effects, []);
});
test('paused session still rejects Start before assigning a number', async () => {
    const f = fixture({ uuid: null, paused: true });
    await assert.rejects(f.run('startConsultation'), e => e.statusCode === 409);
    assert.equal(f.state().uuid, null);
    assert.deepEqual(f.effects, []);
});
test('reopening an in-progress consultation does not allocate another number', async () => {
    const f = fixture({ queueStatus: 'IN_PROGRESS' });
    assert.equal((await f.run('startConsultation')).success, true);
    assert.equal(f.state().uuid, 'DTH123');
    assert.equal(f.state().serial, 2020);
    assert(!f.queries.some(sql => sql.includes('FROM master_users')));
    assert.deepEqual(f.state().events, []);
});
test('existing direct-consult branch leaves queue and registration unchanged', async () => {
    const f = fixture({ uuid: null, otherRunning: true });
    assert.equal((await f.run('startConsultation')).data.direct_consultation, true);
    assert.equal(f.state().appointment.queue_status, 'CHECKED_IN');
    assert.equal(f.state().uuid, null);
    assert.deepEqual(f.effects, []);
});

test('real database: controller Start/Complete, saved DTH, pending DTH and rollback', {
    skip: process.env.RUN_DTH_CHECKIN_DB_TEST !== '1',
}, async () => {
    require('dotenv').config();
    const mysql = require('mysql2/promise');
    const db = await mysql.createConnection({ host: process.env.DB_HOST, port: process.env.DB_PORT,
        user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME });
    const suffix = `${Date.now()}_${process.pid}`;
    const tables = Object.fromEntries(['tbl_appointments','master_users','tbl_patient_registration_sequence','tbl_live_queue_sessions']
        .map((name, i) => [name, `codex_consult_${i}_${suffix}`]));
    const connection = { execute: (sql, params = []) => {
        for (const [name, isolated] of Object.entries(tables)) sql = sql.replaceAll(name, isolated);
        return db.execute(sql, params);
    }};
    let failProjection = false;
    const effects = [];
    const globals = {
        asyncHandler: fn => fn, AppError, toPositiveInt: Number,
        QUEUE_STATUS: { BOOKED: 'BOOKED', CHECKED_IN: 'CHECKED_IN', WAITING: 'WAITING', IN_PROGRESS: 'IN_PROGRESS', COMPLETED: 'COMPLETED' },
        SESSION_STATUS: { COMPLETED: 'COMPLETED' }, ACTIVE_QUEUE_STATUSES: ['BOOKED','CHECKED_IN','WAITING','IN_PROGRESS'],
        withTransaction: async fn => {
            await db.beginTransaction();
            try { const value = await fn(connection); await db.commit(); return value; }
            catch (e) { await db.rollback(); throw e; }
        },
        ensurePatientRegistration, getActorUserId: () => 1, getClientIp: () => '127.0.0.1',
        getNextArrivalSequence: async () => 2, ensureQueueSession: async () => {},
        assertQueueSessionCanAdvance: async () => {}, logQueueEvent: async () => {},
        recalculateLiveRuntimeProjection: async () => { if (failProjection) throw new Error('Projection failed'); },
        cancelScheduledAutoCallNext: async () => effects.push('cancel'),
        scheduleAutoCallNext: async () => { effects.push('schedule'); return null; },
        DEFAULT_AUTO_CALL_DELAY_MS: 0, formatDateTimeForSql: value => value,
        emitLiveQueueEvent: async payload => { effects.push('emit'); return payload; },
    };
    const handlers = loadHandlers(globals);
    const invoke = async (name, id) => {
        let response;
        await handlers[name]({ params: { appointment_id: id }, user: { id: 1 }, headers: {} }, {
            status() { return this; }, json(value) { response = value; },
        });
        assert.equal(response.success, true);
    };
    try {
        await db.query(`CREATE TEMPORARY TABLE ${tables.master_users} (id INT PRIMARY KEY,uuid CHAR(36) NULL UNIQUE,role VARCHAR(10)) ENGINE=InnoDB`);
        await db.query(`CREATE TEMPORARY TABLE ${tables.tbl_patient_registration_sequence} (id INT PRIMARY KEY,last_serial BIGINT UNSIGNED NOT NULL) ENGINE=InnoDB`);
        await db.query(`CREATE TEMPORARY TABLE ${tables.tbl_appointments} (
            appointment_id INT PRIMARY KEY,fk_patient_id INT NOT NULL,fk_branch_id INT,fk_slot_id INT,appointment_date DATE,
            current_token_number INT,queue_status VARCHAR(25),status VARCHAR(25),is_active INT,checked_in_at DATETIME,
            arrival_sequence INT,planned_start_at DATETIME,actual_called_at DATETIME,actual_started_at DATETIME,
            actual_completed_at DATETIME,last_queue_event_at DATETIME,updated_by INT,updated_ip VARCHAR(45)) ENGINE=InnoDB`);
        await db.query(`CREATE TEMPORARY TABLE ${tables.tbl_live_queue_sessions} (
            fk_branch_id INT,fk_slot_id INT,appointment_date DATE,session_status VARCHAR(25),session_started_at DATETIME,
            session_ended_at DATETIME,current_appointment_id INT,current_token_number INT,auto_call_next_due_at DATETIME,
            auto_call_next_reason VARCHAR(100),updated_by INT) ENGINE=InnoDB`);
        await db.query(`INSERT INTO ${tables.master_users} VALUES (9,'DTH123','PAT'),(10,NULL,'PAT'),(11,NULL,'PAT'),(12,NULL,'PAT')`);
        await db.query(`INSERT INTO ${tables.tbl_patient_registration_sequence} VALUES (1,2020)`);
        await db.query(`INSERT INTO ${tables.tbl_live_queue_sessions} (fk_branch_id,fk_slot_id,appointment_date,session_status) VALUES (1,1,'2026-11-01','RUNNING')`);
        for (const [id, patient] of [[7,9],[8,10],[9,11],[10,12]]) {
            await db.query(`INSERT INTO ${tables.tbl_appointments} (appointment_id,fk_patient_id,fk_branch_id,fk_slot_id,appointment_date,current_token_number,queue_status,status,is_active,checked_in_at,arrival_sequence)
                VALUES (?,?,1,1,'2026-11-01',?,'CHECKED_IN','Pending',1,NOW(),1)`, [id,patient,id]);
        }
        for (const id of [7,8]) {
            await invoke('startConsultation', id);
            const [[started]] = await db.query(`SELECT queue_status,actual_started_at FROM ${tables.tbl_appointments} WHERE appointment_id=?`,[id]);
            assert.equal(started.queue_status,'IN_PROGRESS'); assert.ok(started.actual_started_at);
            await invoke('completeConsultation', id);
            const [[done]] = await db.query(`SELECT queue_status,actual_completed_at FROM ${tables.tbl_appointments} WHERE appointment_id=?`,[id]);
            assert.equal(done.queue_status,'COMPLETED'); assert.ok(done.actual_completed_at);
        }
        failProjection = true;
        const effectCount = effects.length;
        await assert.rejects(invoke('startConsultation',9), /Projection failed/);
        assert.equal(effects.length,effectCount);
        const [[rolledBack]] = await db.query(`SELECT queue_status,actual_started_at FROM ${tables.tbl_appointments} WHERE appointment_id=9`);
        assert.equal(rolledBack.queue_status,'CHECKED_IN'); assert.equal(rolledBack.actual_started_at,null);
        failProjection = false;
        await invoke('completeConsultation',10);
        const [patients] = await db.query(`SELECT id,uuid FROM ${tables.master_users} ORDER BY id`);
        assert.deepEqual(patients.map(r => r.uuid), ['DTH123','DTH_2021',null,'DTH_2022']);
        const [[counter]] = await db.query(`SELECT last_serial FROM ${tables.tbl_patient_registration_sequence} WHERE id=1`);
        assert.equal(Number(counter.last_serial),2022);
    } finally {
        // These connection-private tables disappear on close; real patient tables
        // are never written, renamed or used as test fixtures.
        await db.end();
    }
});
