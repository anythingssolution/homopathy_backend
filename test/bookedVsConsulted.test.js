const test = require('node:test');
const assert = require('node:assert/strict');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-booked-vs-consulted-secret';
process.env.DB_HOST = process.env.DB_HOST || '127.0.0.1';
process.env.DB_USER = process.env.DB_USER || 'test';
process.env.DB_NAME = process.env.DB_NAME || 'test';

const {
    normalizeReportBreakdown,
} = require('../services/reports/appointment/bookedVsConsulted');

test('booked report breakdown reconciles consulted, unconsulted, rejected and cancelled counts', () => {
    const breakdown = normalizeReportBreakdown({
        booked_count: '3479',
        consulted_count: '2776',
        rejected_count: '490',
        cancelled_count: '1',
    });

    assert.deepEqual(breakdown, {
        booked_count: 3479,
        consulted_count: 2776,
        rejected_count: 490,
        cancelled_count: 1,
        unconsulted_count: 212,
    });
    assert.equal(
        breakdown.booked_count,
        breakdown.consulted_count
            + breakdown.unconsulted_count
            + breakdown.rejected_count
            + breakdown.cancelled_count
    );
});

test('empty report periods return a zeroed measurable breakdown', () => {
    assert.deepEqual(normalizeReportBreakdown(), {
        booked_count: 0,
        consulted_count: 0,
        rejected_count: 0,
        cancelled_count: 0,
        unconsulted_count: 0,
    });
});
