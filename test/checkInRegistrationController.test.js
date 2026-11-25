const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const AppError = require('../utils/AppError');
const { ensurePatientRegistration } = require('../utils/patientUuid');
const source = fs.readFileSync(require.resolve('../controllers/v1/liveQueueController'), 'utf8');
const start = source.indexOf('const checkInAppointment =');
const end = source.indexOf('\nconst callToken =', start);

function fixture({ paid = true, failProjection = false, assigned = null } = {}) {
    let uuid = assigned, serial = 2020, checkedIn = false;
    const events = [];
    const appointment = { appointment_id: 7, fk_patient_id: 9, fk_branch_id: 1, fk_slot_id: 1,
        appointment_date: '2026-10-31', queue_status: 'BOOKED', status: 'Pending', is_active: 1,
        consultation_payment_status: paid ? 'PAID' : 'UNPAID' };
    const connection = { execute: async (sql, params = []) => {
        if (sql.includes('FROM tbl_appointments a')) return [[appointment]];
        if (sql.includes('SELECT NOW()')) return [[{ checked_in_at: '2026-10-31 11:00:00' }]];
        if (sql.includes('SELECT id, uuid')) return [[{ id: 9, uuid }]];
        if (sql.includes('SELECT last_serial')) return [[{ last_serial: serial }]];
        if (sql.includes('UPDATE tbl_patient_registration_sequence')) { serial = Number(params[0]); return [{ affectedRows: 1 }]; }
        if (sql.includes('UPDATE master_users')) { uuid = params[0]; return [{ affectedRows: 1 }]; }
        if (sql.includes('UPDATE tbl_appointments')) { checkedIn = true; return [{ affectedRows: 1 }]; }
        throw new Error(sql);
    }};
    const handler = vm.runInNewContext(`${source.slice(start, end)}; checkInAppointment`, {
        asyncHandler: fn => fn, AppError, toPositiveInt: Number, query: async () => [appointment],
        withTransaction: async fn => {
            const before = { uuid, serial, checkedIn, eventCount: events.length };
            try { return await fn(connection); }
            catch (error) { ({ uuid, serial, checkedIn } = before); events.length = before.eventCount; throw error; }
        },
        QUEUE_STATUS: { BOOKED: 'BOOKED', WAITING: 'WAITING', CHECKED_IN: 'CHECKED_IN' },
        getActorUserId: () => 1, getClientIp: () => '127.0.0.1',
        getVisitTypeCode: () => 'FIRST_CONSULTATION', isFollowUpBookingVisitType: () => false,
        getNextArrivalSequence: async () => 1, getLiveQueueSnapshot: async () => ({}),
        extractProtectedVisibleWindowAppointmentIds: () => [],
        resolveBoundedEarlyArrivalAssignments: () => ({ assignments: [], displacedAssignments: [] }),
        ensurePatientRegistration, logQueueEvent: async (_connection, event) => { events.push(event); }, emitLiveQueueEvent: async () => ({}),
        recalculateLiveRuntimeProjection: async () => { if (failProjection) throw new Error('projection failed'); },
    });
    return { events, state: () => ({ uuid, serial, checkedIn }), run: async () => {
        let output;
        const res = { code: 200, status(code) { this.code = code; return this; }, json(body) { output = { code: this.code, body }; } };
        await handler({ params: { appointment_id: 7 }, user: { id: 1 }, headers: {} }, res);
        return output;
    }};
}
test('successful check-in allocates DTH in the same transaction as attendance', async () => {
    const f = fixture(); assert.equal((await f.run()).code, 200);
    assert.deepEqual(f.state(), { uuid: 'DTH_2021', serial: 2021, checkedIn: true });
    assert.equal(f.events.find(event => event.eventType === 'CHECKED_IN').meta.patient_source_collection, 'CHECK_IN');
});
test('payment-required check-in consumes no registration number', async () => {
    const f = fixture({ paid: false }); assert.equal((await f.run()).code, 409);
    assert.deepEqual(f.state(), { uuid: null, serial: 2020, checkedIn: false });
    assert.equal(f.events.length, 0);
});
test('failed check-in rolls back the assigned number and sequence', async () => {
    const f = fixture({ failProjection: true }); await assert.rejects(f.run(), /projection failed/);
    assert.deepEqual(f.state(), { uuid: null, serial: 2020, checkedIn: false });
    assert.equal(f.events.length, 0);
});
test('existing assigned number is unchanged on check-in', async () => {
    const f = fixture({ assigned: 'DTH123' }); await f.run();
    assert.deepEqual(f.state(), { uuid: 'DTH123', serial: 2020, checkedIn: true });
});
