const test = require('node:test');
const assert = require('node:assert/strict');
process.env.JWT_SECRET ||= 'test-weekday-secret';
process.env.DB_HOST ||= '127.0.0.1'; process.env.DB_USER ||= 'test'; process.env.DB_NAME ||= 'test';
const { toMatrix, revisionFor, validateChanges, slotAvailability, validDate, assertWeeklyBookingOpen, withWeeklyTimings } = require('../services/bookingWeekdayService');
const slots = [{ slot_id: 3, branch_id: 2, slot_name: 'Morning Session' }];
test('missing settings keep all seven days open; explicit OFF is preserved', () => {
    const defaults = toMatrix(slots, []);
    assert.equal(defaults[0].weekdays.length, 7);
    assert.ok(defaults[0].weekdays.every(row => row.booking_enabled));
    const configured = toMatrix(slots, [{ fk_slot_id: 3, day_of_week: 3, booking_enabled: 0 }]);
    assert.equal(slotAvailability(configured[0], 3).booking_enabled, false);
    assert.equal(slotAvailability(configured[0], 4).booking_enabled, true);
});
test('Tuesday-only rule uses existing 1=Sunday numbering and clear closed-day reasons', () => {
    const matrix = toMatrix(slots, Array.from({length:7}, (_,i) => ({fk_slot_id:3,day_of_week:i+1,booking_enabled:i===2?1:0})));
    assert.equal(slotAvailability(matrix[0], 3).booking_enabled, true);
    assert.match(slotAvailability(matrix[0], 2).reason, /only on Tuesday/);
    assert.equal(slotAvailability(matrix[0], 5).booking_enabled, false);
});
test('all OFF never falls back to open and invalid calendar dates are rejected', () => {
    const matrix = toMatrix(slots, Array.from({length:7}, (_,i) => ({fk_slot_id:3,day_of_week:i+1,booking_enabled:0})));
    for(let day=1;day<=7;day++) assert.equal(slotAvailability(matrix[0], day).booking_enabled, false);
    assert.match(slotAvailability(matrix[0], 2).reason, /closed on all days/);
    assert.equal(validDate('2026-02-30'), false); assert.equal(validDate('2026-10-20'), true);
});
test('save validation rejects unauthorized slots, partial, duplicate and non-boolean values', () => {
    const changes = toMatrix(slots, [])[0].weekdays.map(row => ({slot_id:3,...row}));
    assert.doesNotThrow(() => validateChanges(changes, slots));
    for(const invalid of [changes.slice(1), changes.map(row=>({...row,slot_id:99})), changes.map(row=>({...row,booking_enabled:1})), changes.map(()=>changes[0])]) {
        assert.throws(() => validateChanges(invalid, slots), {statusCode:400});
    }
    const before = toMatrix(slots, []), after = toMatrix(slots, [{fk_slot_id:3,day_of_week:2,booking_enabled:0}]);
    assert.notEqual(revisionFor(before), revisionFor(after));
});
test('final validation locks slots and settings, rejects OFF, and allows an unconfigured day', async () => {
    const seen = [];
    const connection = {execute: async (sql) => { seen.push(sql); return [sql.includes('FROM master_slots') ? [{id:3}] : [{fk_slot_id:3,day_of_week:2,booking_enabled:0}]]; }};
    await assert.rejects(assertWeeklyBookingOpen({branchId:2,slotId:3,appointmentDate:'2026-10-19',connection}), {statusCode:409});
    assert.ok(seen.every(sql=>sql.includes('LOCK IN SHARE MODE')));
    await assert.doesNotReject(assertWeeklyBookingOpen({branchId:2,slotId:3,appointmentDate:'2026-10-20',connection}));
});

test('read-only timing preview preserves default duration and uses slot-specific rule before first-slot rule', () => {
    const slots = toMatrix([
        {slot_id:1,branch_id:1,start_time:'18:00:00',end_time:'21:00:00'},
        {slot_id:2,branch_id:1,start_time:'11:00:00',end_time:'14:30:00'},
        {slot_id:3,branch_id:2,start_time:'11:30:00',end_time:'17:30:00'},
    ], []);
    const result = withWeeklyTimings(slots, [
        {id:1,fk_branch_id:2,fk_slot_id:null,day_of_week:5,override_start_time:'15:00:00'},
        {id:2,fk_branch_id:1,fk_slot_id:null,day_of_week:3,override_start_time:'12:00:00'},
        {id:3,fk_branch_id:1,fk_slot_id:2,day_of_week:3,override_start_time:'13:00:00'},
    ]);
    assert.equal(result[2].weekly_timings[4].start_time,'15:00:00');
    assert.equal(result[2].weekly_timings[4].end_time,'21:00:00');
    assert.equal(result[2].weekly_timings[5].start_time,'11:30:00');
    assert.equal(result[1].weekly_timings[2].start_time,'13:00:00');
    assert.equal(result[0].weekly_timings[2].start_time,'18:00:00');
    assert.equal(revisionFor(result),revisionFor(slots));
    assert.equal(slots[2].start_time,'11:30:00');
});
