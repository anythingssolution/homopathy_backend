const test = require('node:test');
const assert = require('node:assert/strict');
let active, busy, called, validSlot, failInsert, statements, sideEffects, rolledBack;
const seed = () => {
    active = { doctor_session_id: 1, doctor_id: 9, branch_id: 1, slot_id: 1, session_status: 'IN' };
    busy = false; called = []; validSlot = true; failInsert = false; statements = []; sideEffects = []; rolledBack = false;
};
const mock = (path, exports) => { const id = require.resolve(path); require.cache[id] = { id, filename: id, loaded: true, exports }; };
const connection = { execute: async (sql, params = []) => {
    statements.push({ sql, params });
    if (sql.startsWith('SELECT id FROM master_users')) return [[{ id: 9 }]];
    if (sql.startsWith('SELECT id FROM master_slots')) return [validSlot ? [{ id: 2 }] : []];
    if (sql.includes('FROM tbl_doctor_live_sessions s')) return [sql.includes('WHERE s.id = ?')
        ? [{ doctor_session_id: 2, doctor_id: 9, branch_id: 1, slot_id: 2, session_status: 'IN' }]
        : active ? [active] : []];
    if (sql.includes('FROM tbl_appointments a')) return [busy ? [{ appointment_id: 77, queue_status: 'IN_PROGRESS', actual_started_at: '2026-10-22 11:05:00' }] : called];
    if (sql.includes('FROM tbl_live_queue_sessions s')) return [[{ id: params.includes('PAUSED') ? 12 : 11,
        fk_branch_id: 1, fk_slot_id: params.includes('PAUSED') ? 2 : 1, appointment_date: '2026-10-22',
        current_appointment_id: null, session_status: params.includes('PAUSED') ? 'NOT_STARTED' : 'RUNNING' }]];
    if (sql.includes('FROM tbl_appointments') && sql.includes('actual_called_at')) return [[]];
    if (sql.includes('INSERT INTO tbl_doctor_live_sessions')) {
        if (failInsert) throw new Error('insert failed');
        return [{ insertId: 2 }];
    }
    if (sql.includes('UPDATE ') || sql.includes('INSERT INTO tbl_doctor_live_session_logs')) return [{ affectedRows: 1 }];
    throw new Error(`Unexpected SQL: ${sql}`);
} };
mock('../config/db', { query: async () => [], withTransaction: async fn => {
    try { return await fn(connection); } catch (error) { rolledBack = true; throw error; }
} });
mock('../utils/realtime', { emitDoctorSessionUpdate: payload => sideEffects.push(['emit', payload.slot_id]) });
mock('../services/liveQueueAutomationService', {
    scheduleAutoCallNext: async context => sideEffects.push(['schedule', context.slotId]),
    cancelScheduledAutoCallNext: async context => sideEffects.push(['cancel', context.slotId]),
    DEFAULT_RESUME_AUTO_CALL_DELAY_MS: 0,
});
mock('../services/liveQueueService', {
    ACTIVE_QUEUE_STATUSES: ['BOOKED', 'WAITING', 'IN_PROGRESS'],
    recalculateLiveRuntimeProjection: async (_, context) => sideEffects.push(['projection', context.slotId]),
    listBranchSlotBlockContexts: async ({ slotId }) => ({ slots: [{ slotId }] }),
    logQueueEvent: async (_, event) => sideEffects.push(['audit', event]),
    ensureQueueSession: async (_, context) => sideEffects.push(['ensure', context.slotId]),
    parseMysqlDateTime: value => value ? new Date(value) : null,
    formatDateTimeForSql: date => date.toISOString().slice(0, 19).replace('T', ' '),
});
const { startDoctorSession } = require('../services/doctorSessionService');
const request = { doctorId: 9, branchId: 1, slotId: 2, actorUserId: 9, actorRole: 'DOC', allowSlotSwitch: true };

test('legacy start still returns existing session without switching or calling another patient', async () => {
    seed(); const result = await startDoctorSession({ ...request, allowSlotSwitch: false });
    assert.equal(result.changed, false); assert.equal(result.payload.slot_id, 1);
    assert.equal(statements.filter(entry => /UPDATE |INSERT /.test(entry.sql)).length, 0);
    assert.deepEqual(sideEffects, [['emit', 1]]);
});
test('explicit selection pauses old queue and starts only chosen slot, preserving appointments', async () => {
    seed(); const result = await startDoctorSession(request);
    assert.equal(result.changed, true); assert.equal(result.payload.slot_id, 2);
    assert.ok(statements.some(entry => entry.sql.includes("session_status = 'OUT'")));
    assert.ok(statements.some(entry => entry.sql.includes('auto_call_next_due_at = NULL')));
    assert.equal(statements.filter(entry => /UPDATE tbl_appointments|UPDATE tbl_bills/.test(entry.sql)).length, 0);
    assert.ok(sideEffects.some(entry => entry[0] === 'cancel' && entry[1] === 1));
    assert.ok(sideEffects.some(entry => entry[0] === 'schedule' && entry[1] === 2));
    assert.equal(sideEffects.filter(entry => entry[0] === 'schedule' && entry[1] === 1).length, 0);
    assert.equal(statements.filter(entry => entry.sql.includes('INSERT INTO tbl_doctor_live_session_logs')).length, 2);
});
test('same slot is idempotent and does not auto-call twice', async () => {
    seed(); active.slot_id = 2;
    assert.equal((await startDoctorSession(request)).changed, false);
    assert.equal(sideEffects.filter(entry => entry[0] === 'schedule').length, 0);
});
for (const noSession of [false, true]) test(`in-progress patient blocks selection ${noSession ? 'without' : 'with'} active session`, async () => {
    seed(); busy = true; if (noSession) active = null;
    await assert.rejects(startDoctorSession(request), { statusCode: 409 });
    assert.equal(statements.filter(entry => /UPDATE |INSERT /.test(entry.sql)).length, 0);
});
test('wrong branch slot and active session in another branch are rejected', async () => {
    seed(); validSlot = false; await assert.rejects(startDoctorSession(request), { statusCode: 409 });
    seed(); active.branch_id = 2; await assert.rejects(startDoctorSession(request), { statusCode: 409 });
    assert.equal(statements.filter(entry => /UPDATE |INSERT /.test(entry.sql)).length, 0);
});
test('failed new session stays inside rollback and never broadcasts or schedules after failure', async () => {
    seed(); failInsert = true; await assert.rejects(startDoctorSession(request), /insert failed/);
    assert.equal(rolledBack, true);
    assert.equal(sideEffects.filter(entry => ['emit', 'schedule', 'cancel'].includes(entry[0])).length, 0);
});
test('selected session can start when doctor is out', async () => {
    seed(); active = null;
    assert.equal((await startDoctorSession(request)).payload.slot_id, 2);
    assert.equal(statements.filter(entry => entry.sql.includes("session_status = 'OUT'")).length, 0);
});

const sampleCalled = { appointment_id: 77, fk_slot_id: 1, current_token_number: 36, patient_name: 'Sample Patient',
    queue_status: 'WAITING', checked_in_at: '2026-10-22 11:00:00', actual_started_at: null, called_at: '2026-10-22 11:05:00' };
const confirm = () => called.map(({ appointment_id, called_at }) => ({ appointment_id, called_at }));
test('preview lists called patient without changing queues, scheduling calls or broadcasting', async () => {
    seed(); called = [{ ...sampleCalled }];
    const result = await startDoctorSession({ ...request, previewOnly: true });
    assert.equal(result.selectionPreview, true);
    assert.deepEqual(result.calledPatients, called);
    assert.equal(statements.filter(entry => /UPDATE |INSERT /.test(entry.sql)).length, 0);
    assert.deepEqual(sideEffects, []);
});
test('called patient needs explicit confirmation and a changed call must be reviewed again', async () => {
    seed(); called = [{ ...sampleCalled }];
    for (const confirmedCalledPatients of [[], [{ appointment_id: 77, called_at: '2026-10-22 11:04:00' }], [{ appointment_id: 78, called_at: sampleCalled.called_at }]]) {
        await assert.rejects(startDoctorSession({ ...request, confirmedCalledPatients }), error => {
            assert.equal(error.statusCode, 409);
            assert.equal(error.details.code, 'CONFIRM_CALLED_SESSION_SWITCH');
            assert.equal(error.details.called_patients[0].appointment_id, 77);
            return true;
        });
    }
    assert.equal(statements.filter(entry => /UPDATE |INSERT /.test(entry.sql)).length, 0);
});
test('confirmed auto-called patient returns to waiting with presence, arrival order, payment and token intact', async () => {
    seed(); called = [{ ...sampleCalled }];
    await startDoctorSession({ ...request, confirmedCalledPatients: confirm() });
    const update = statements.find(entry => entry.sql.includes('UPDATE tbl_appointments'));
    assert.deepEqual(update.params, ['CHECKED_IN', 9, null, 77]);
    assert.match(update.sql, /actual_called_at = NULL/);
    assert.doesNotMatch(update.sql, /\b(?:checked_in_at|arrival_sequence|not_available_at|current_token_number|token_number|fk_slot_id|status|consultation_fee|consultation_payment_status)\s*=/);
    assert.equal(sideEffects.filter(entry => entry[0] === 'audit')[0][1].eventType, 'SESSION_SWITCH_CALL_RELEASED');
    assert.ok(sideEffects.some(entry => entry[0] === 'cancel' && entry[1] === 1));
    assert.ok(sideEffects.some(entry => entry[0] === 'schedule' && entry[1] === 2));
});
test('consultation starting after preview still blocks even with confirmation', async () => {
    seed(); called = [{ ...sampleCalled, actual_started_at: '2026-10-22 11:06:00' }];
    await assert.rejects(startDoctorSession({ ...request, confirmedCalledPatients: confirm() }), { statusCode: 409 });
    assert.equal(statements.filter(entry => /UPDATE |INSERT /.test(entry.sql)).length, 0);
});
test('incoming session called patient is preserved and is not released', async () => {
    seed(); called = [{ ...sampleCalled, fk_slot_id: 2 }];
    await startDoctorSession(request);
    assert.equal(statements.filter(entry => entry.sql.includes('UPDATE tbl_appointments')).length, 0);
});
test('preview while doctor is out has no start side effects', async () => {
    seed(); active = null;
    await startDoctorSession({ ...request, previewOnly: true });
    assert.equal(statements.filter(entry => /UPDATE |INSERT /.test(entry.sql)).length, 0);
    assert.deepEqual(sideEffects, []);
});

test('failure after releasing a confirmed call rolls back instead of starting another queue', async () => {
    seed(); called = [{ ...sampleCalled }]; failInsert = true;
    await assert.rejects(startDoctorSession({ ...request, confirmedCalledPatients: confirm() }), /insert failed/);
    assert.equal(rolledBack, true);
    assert.equal(sideEffects.filter(entry => ['emit', 'schedule', 'cancel'].includes(entry[0])).length, 0);
});
