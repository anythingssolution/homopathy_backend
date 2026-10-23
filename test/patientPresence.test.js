const test = require('node:test');
const assert = require('node:assert/strict');

let appointment, consultation, statements, events, failProjection, rolledBack;
const seed = () => {
    appointment = { appointment_id: 77, fk_branch_id: 1, fk_slot_id: 1,
        appointment_date: '2026-10-22', current_token_number: 12, queue_status: 'WAITING',
        status: 'Pending', is_active: 1, is_today: 1, checked_in_at: '2026-10-22 11:05:00',
        actual_started_at: null, actual_completed_at: null };
    consultation = false; statements = []; events = []; failProjection = false; rolledBack = false;
};
const mock = (path, exports) => { const id = require.resolve(path); require.cache[id] = { id, filename: id, loaded: true, exports }; };
mock('../config/db', { withTransaction: async fn => {
    try { return await fn({ execute: async (sql, params) => {
        statements.push({ sql, params });
        if (sql.includes('FROM tbl_appointments')) return [[Number(params[1]) === appointment?.fk_branch_id ? appointment : null].filter(Boolean)];
        if (sql.includes('FROM tbl_consultations')) return [consultation ? [{ id: 8 }] : []];
        if (sql.startsWith('UPDATE')) return [{ affectedRows: 1 }];
        throw new Error(`Unexpected SQL: ${sql}`);
    } }); } catch (error) { rolledBack = true; throw error; }
} });
mock('../services/liveQueueService', {
    logQueueEvent: async (_, event) => events.push(event),
    recalculateLiveRuntimeProjection: async () => { if (failProjection) throw new Error('projection failed'); },
});
const { markPatientLeft } = require('../services/patientPresenceService');
const request = { appointmentId: 77, branchId: 1, actorUserId: 9, actorIp: '127.0.0.1', reason: 'Left for work' };

test('patient left removes presence but never writes booking, payment, fee, date or token numbers', async () => {
    seed();
    assert.deepEqual(await markPatientLeft(request), { branchId: 1, slotId: 1, appointmentDate: '2026-10-22' });
    const update = statements.find(entry => entry.sql.startsWith('UPDATE tbl_appointments'));
    assert.match(update.sql, /checked_in_at = NULL/);
    assert.match(update.sql, /actual_called_at = NULL/);
    assert.match(update.sql, /queue_status = 'BOOKED'/);
    assert.match(update.sql, /arrival_sequence = NULL/);
    assert.doesNotMatch(update.sql, /(?:\bstatus|\btoken_number|\bcurrent_token_number|\bappointment_date|\bconsultation_fee|\bconsultation_payment_status)\s*=/);
    assert.equal(statements.filter(entry => /UPDATE tbl_bills|INSERT INTO tbl_bills/.test(entry.sql)).length, 0);
    assert.equal(events[0].eventType, 'PATIENT_LEFT');
    assert.equal(events[0].tokenNumber, 12);
    assert.deepEqual(events[0].meta, { reason: 'Left for work' });
    const pointer = statements.find(entry => entry.sql.startsWith('UPDATE tbl_live_queue_sessions'));
    assert.ok(pointer.sql.indexOf('current_token_number =') < pointer.sql.indexOf('current_appointment_id = CASE'));
    assert.deepEqual(pointer.params, [77, 77, 9, 1, 1, '2026-10-22']);
});

for (const [label, changes] of [
    ['past date', { is_today: 0 }], ['inactive', { is_active: 0 }],
    ['completed', { status: 'Completed' }], ['cancelled', { status: 'Cancelled' }],
    ['in cabin', { queue_status: 'IN_PROGRESS' }], ['started consultation', { actual_started_at: '2026-10-22 11:10:00' }],
    ['completed timestamp', { actual_completed_at: '2026-10-22 11:20:00' }], ['already left', { checked_in_at: null }],
]) test(`patient left rejects ${label} without any update`, async () => {
    seed(); Object.assign(appointment, changes);
    await assert.rejects(markPatientLeft(request), { statusCode: 409 });
    assert.equal(statements.filter(entry => entry.sql.startsWith('UPDATE')).length, 0);
});
test('branch scope and existing consultation protect the record', async () => {
    seed(); await assert.rejects(markPatientLeft({ ...request, branchId: 2 }), { statusCode: 404 });
    seed(); consultation = true; await assert.rejects(markPatientLeft(request), { statusCode: 409 });
    assert.equal(statements.filter(entry => entry.sql.startsWith('UPDATE')).length, 0);
});
test('invalid IDs and missing reason never enter the transaction', async () => {
    seed();
    for (const change of [{ appointmentId: -1 }, { branchId: null }, { reason: '' }, { reason: 'x'.repeat(256) }]) {
        await assert.rejects(markPatientLeft({ ...request, ...change }), { statusCode: 400 });
    }
    assert.equal(statements.length, 0);
});
test('projection failure rejects the whole transaction', async () => {
    seed(); failProjection = true;
    await assert.rejects(markPatientLeft(request), /projection failed/);
    assert.equal(rolledBack, true);
});
