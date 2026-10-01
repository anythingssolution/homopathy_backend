const test = require('node:test');
const assert = require('node:assert/strict');
const { sortCompletedAppointmentsRecentFirst } = require('../utils/doctorAppointmentOrder');

test('completed appointments show the latest consultation first and preserve completion positions', () => {
    const rows = [
        { appointment_id: 11, appointment_date: '2026-09-24', actual_completed_at: '2026-09-24 10:15:00', queue_position: 1 },
        { appointment_id: 21, appointment_date: '2026-09-25', actual_completed_at: '2026-09-25 11:15:00', queue_position: 2 },
        { appointment_id: 20, appointment_date: '2026-09-25', actual_completed_at: '2026-09-25 10:45:00', queue_position: 1 },
    ];

    const result = sortCompletedAppointmentsRecentFirst(rows);

    assert.deepEqual(result.map((row) => row.appointment_id), [21, 20, 11]);
    assert.deepEqual(result.map((row) => row.queue_position), [2, 1, 1]);
    assert.deepEqual(rows.map((row) => row.appointment_id), [11, 21, 20]);
});

test('completed appointment order falls back to position when completion time is missing', () => {
    const result = sortCompletedAppointmentsRecentFirst([
        { appointment_id: 30, appointment_date: '2026-09-25', actual_completed_at: null, queue_position: 1 },
        { appointment_id: 31, appointment_date: '2026-09-25', actual_completed_at: null, queue_position: 2 },
    ]);

    assert.deepEqual(result.map((row) => row.appointment_id), [31, 30]);
});
