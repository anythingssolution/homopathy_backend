const test = require('node:test');
const assert = require('node:assert/strict');

test('appointment list counts match existing status cards in each branch (read only)', { skip: process.env.RUN_APPOINTMENT_LIST_DB_TEST !== '1' }, async t => {
    require('dotenv').config({ quiet: true });
    const { pool } = require('../config/db');
    t.after(() => pool.end());
    const getStatusAppointments = require('../services/reports/appointment/statusAppointments');
    const { getAppointmentList, CARD_STATUSES } = require('../services/reports/appointment/appointmentList');
    const to = new Date();
    const from = new Date(to); from.setDate(from.getDate() - 14);
    const format = date => date.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    for (const branchId of [1, 2]) {
        const scope = { fromDate: format(from), toDate: format(to), branchId };
        const counts = await getStatusAppointments(scope);
        for (const [status, statuses] of Object.entries(CARD_STATUSES)) {
            const { rows } = await getAppointmentList({ ...scope, status });
            const expected = counts.filter(row => statuses.includes(row.status)).reduce((sum, row) => sum + Number(row.total_appointments), 0);
            assert.equal(rows.length, expected, `${branchId}/${status}`);
            assert.equal(new Set(rows.map(row => row.appointment_id)).size, rows.length);
            assert.ok(rows.every(row => statuses.includes(row.status)));
        }
    }
});
