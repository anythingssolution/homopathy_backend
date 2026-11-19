const test = require('node:test');
const assert = require('node:assert/strict');
process.env.JWT_SECRET = 'patient-discovery-test';
process.env.DB_HOST = '127.0.0.1'; process.env.DB_USER = 'test'; process.env.DB_NAME = 'test';
const db = require('../config/db');
let calls = [];
let appointment;
const answers = new Map();
db.query = async (sql, params) => {
    calls.push({ sql, params });
    if (sql.includes('FROM tbl_appointments WHERE')) {
        if (!appointment) return [];
        if (sql.includes('booked_by_user_id = ?')) return params[1] === appointment.booked_by_user_id ? [appointment] : [];
        return !sql.includes('fk_patient_id = ?') || params[1] === appointment.fk_patient_id ? [appointment] : [];
    }
    if (sql.startsWith('UPDATE tbl_patient_discovery_sources')) { if (answers.has(params[2])) answers.set(params[2], { source_code: params[0], other_detail: params[1] }); return {}; }
    if (sql.startsWith('INSERT')) { if (!answers.has(params[0])) answers.set(params[0], { source_code: params[4], other_detail: params[5] }); return {}; }
    if (sql.startsWith('SELECT source_code')) return answers.has(params[0]) ? [answers.get(params[0])] : [];
    return [];
};
const service = require('../services/patientDiscoverySourceService');
test.beforeEach(() => { calls = []; answers.clear(); appointment = { appointment_id: 50, fk_patient_id: 7, fk_patient_family_member_id: null }; });

test('all source categories are accepted; Facebook and Instagram stay separate', () => {
    assert.equal(Object.keys(service.SOURCE_LABELS).length, 8);
    for (const code of Object.keys(service.SOURCE_LABELS)) assert.equal(service.validateAnswer({ source_code: code, other_detail: 'Poster' }).source_code, code);
});
test('invalid source and missing or oversized Other detail are rejected; unrelated detail is discarded', () => {
    for (const body of [{}, { source_code: 'UNKNOWN' }, { source_code: 'OTHER' }, { source_code: 'OTHER', other_detail: 'x'.repeat(256) }]) assert.throws(() => service.validateAnswer(body), e => e.statusCode === 400);
    assert.deepEqual(service.validateAnswer({ source_code: 'OTHER', other_detail: ' Poster ' }), { source_code: 'OTHER', other_detail: 'Poster' });
    assert.equal(service.validateAnswer({ source_code: 'GOOGLE', other_detail: 'irrelevant' }).other_detail, null);
});
test('patient cannot read or write an appointment owned by another account', async () => {
    await assert.rejects(service.getDiscoverySource(50, 8), e => e.statusCode === 404);
    await assert.rejects(service.saveDiscoverySource(50, 8, { source_code: 'FACEBOOK' }), e => e.statusCode === 404);
    assert.equal(calls.some(c => c.sql.startsWith('INSERT')), false);
});
test('a first answer persists and repeat submissions keep the original answer', async () => {
    assert.equal(await service.getDiscoverySource(50, 7), null);
    await service.saveDiscoverySource(50, 7, { source_code: 'INSTAGRAM' });
    assert.equal((await service.saveDiscoverySource(50, 7, { source_code: 'FACEBOOK' })).source_code, 'INSTAGRAM');
    assert.equal(answers.size, 1);
    assert.match(calls.find(c => c.sql.startsWith('INSERT')).sql, /ON DUPLICATE KEY UPDATE subject_key = VALUES\(subject_key\)/);
});
test('family members and account holder have independent answers', async () => {
    await service.saveDiscoverySource(50, 7, { source_code: 'GOOGLE' });
    appointment.fk_patient_family_member_id = 10;
    await service.saveDiscoverySource(51, 7, { source_code: 'YOUTUBE' });
    appointment.fk_patient_family_member_id = 11;
    assert.equal(await service.getDiscoverySource(52, 7), null);
    assert.equal(answers.get('PAT:7').source_code, 'GOOGLE');
    assert.equal(answers.get('FM:10').source_code, 'YOUTUBE');
});
test('invalid appointment fails before a database request', async () => {
    for (const id of ['x', '0', '-1', '1.5']) await assert.rejects(service.getDiscoverySource(id, 7), e => e.statusCode === 400);
    assert.equal(calls.length, 0);
});
test('report requires branch and uses answer-date boundaries with branch attribution', async () => {
    await assert.rejects(service.getPatientSourceReport({ branchId: null }), e => e.statusCode === 400);
    const result = await service.getPatientSourceReport({ branchId: 2, fromDate: '2026-10-01', toDate: '2026-10-22' });
    assert.deepEqual(calls[0].params, [2, '2026-10-01', '2026-10-22']);
    assert.match(calls[0].sql, /a\.fk_branch_id = \?/);
    assert.match(calls[0].sql, /d\.created_at < DATE_ADD\(\?, INTERVAL 1 DAY\)/);
    assert.equal(result.sources.length, 8);
    assert.equal(result.sources.reduce((sum, source) => sum + source.count, 0), 0);
});

test('reception reuses the existing patient answer and explicit corrections retain one subject row', async () => {
    appointment.booked_by_user_id = 42;
    await service.saveDiscoverySource(50, 7, { source_code: 'GOOGLE' });
    assert.equal((await service.getStaffSource(50, 42)).source_code, 'GOOGLE');
    assert.equal((await service.saveStaffSource(50, { source_code: 'FACEBOOK' }, 42)).source_code, 'GOOGLE');
    assert.equal((await service.saveStaffSource(50, { source_code: 'INSTAGRAM', replace_existing: true }, 42)).source_code, 'INSTAGRAM');
    assert.equal(answers.size, 1);
});
test('booking-owned source endpoint rejects another operator and separates family from Self', async () => {
    appointment.booked_by_user_id = 42;
    await assert.rejects(service.getStaffSource(50, 43), e => e.statusCode === 404);
    await service.saveStaffSource(50, { source_code: 'NOT_KNOWN' }, 42);
    appointment.fk_patient_family_member_id = 19;
    assert.equal(await service.getStaffSource(50, 42), null);
    await service.saveStaffSource(50, { source_code: 'FAMILY_FRIEND' }, 42);
    assert.equal(answers.get('PAT:7').source_code, 'NOT_KNOWN');
    assert.equal(answers.get('FM:19').source_code, 'FAMILY_FRIEND');
});
test('refresh recovery is operator scoped and only tracks new, active, unanswered bookings', async () => {
    await service.getPendingReceptionSource(42);
    assert.deepEqual(calls[0].params, [42]);
    assert.match(calls[0].sql, /tbl_reception_discovery_pending/);
    assert.match(calls[0].sql, /p.actor_id = \?/);
    assert.match(calls[0].sql, /a.is_active = 1/);
    assert.match(calls[0].sql, /a.status <> 'Cancelled'/);
    assert.match(calls[0].sql, /d.subject_key IS NULL/);
    assert.match(calls[0].sql, /FM:/);
});
