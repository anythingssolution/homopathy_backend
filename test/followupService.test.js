const test = require('node:test');
const assert = require('node:assert/strict');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_followup_secret';
process.env.DB_HOST = process.env.DB_HOST || '127.0.0.1';
process.env.DB_USER = process.env.DB_USER || 'test_user';
process.env.DB_NAME = process.env.DB_NAME || 'test_db';

const {
    buildFollowUpHistorySubjectScope,
    resolveFollowUpFeeDecision,
} = require('../services/followupService');

test('follow-up history scope isolates the same family member', () => {
    assert.deepEqual(buildFollowUpHistorySubjectScope('42'), {
        sql: 'AND fk_patient_family_member_id <=> ?',
        params: [42],
    });
});

test('follow-up history scope isolates self visits from family members', () => {
    assert.deepEqual(buildFollowUpHistorySubjectScope(null), {
        sql: 'AND fk_patient_family_member_id <=> ?',
        params: [null],
    });
});

test('follow-up fee keeps the exact branch boundary free', () => {
    assert.deepEqual(resolveFollowUpFeeDecision({
        checkedInAt: '2026-08-01T10:00:00.000Z',
        lastCompletedAt: '2026-07-02T10:00:00.000Z',
        freeDays: 30,
    }), {
        shouldChargeFee: false,
        daysDifference: 30,
        freeDays: 30,
    });
});

test('follow-up fee charges after the configured free-day boundary', () => {
    assert.deepEqual(resolveFollowUpFeeDecision({
        checkedInAt: '2026-08-02T10:00:00.000Z',
        lastCompletedAt: '2026-07-02T10:00:00.000Z',
        freeDays: 30,
    }), {
        shouldChargeFee: true,
        daysDifference: 31,
        freeDays: 30,
    });
});

test('follow-up fee stays free without previous history or branch configuration', () => {
    assert.equal(resolveFollowUpFeeDecision({
        checkedInAt: '2026-08-02T10:00:00.000Z',
        lastCompletedAt: null,
        freeDays: null,
    }).shouldChargeFee, false);
});
