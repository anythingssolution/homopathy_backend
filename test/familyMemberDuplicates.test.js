const test = require('node:test');
const assert = require('node:assert/strict');
process.env.JWT_SECRET = 'family-duplicate-unit-test';
process.env.DB_HOST = '127.0.0.1'; process.env.DB_USER = 'test'; process.env.DB_NAME = 'test';
const { normalizeMemberName, isPossibleFamilyMatch, guardFamilyMemberCreation } = require('../services/familyMemberDuplicateService');

const payload = { full_name: 'VEDIKA CHAWDA', age: 11, date_of_birth: null, gender: 'female', relationship: 'FAMILY', description: null };
const existing = { family_member_id: 723, full_name: 'Vedika Chawda', age: 12, date_of_birth: null, gender: 'female', relationship: 'FAMILY', is_active: 1 };
const fakeConnection = (members = []) => {
    const calls = [];
    return { calls, members, execute: async (sql, params) => {
        calls.push({ sql, params });
        if (sql.includes('FROM master_users')) return [[{ id: params[0] }]];
        if (sql.includes('FROM tbl_patient_family_members')) return [members.map(member => ({ ...member }))];
        if (sql.includes('FROM tbl_appointments')) return [[{ appointment_date: '2026-11-03', branch_name: 'Devendra Nagar' }]];
        throw new Error('Unexpected SQL');
    } };
};

test('same name matches despite case, spacing, punctuation and an age mismatch', () => {
    assert.equal(normalizeMemberName('  VEDIKA   CHAWDA. '), 'vedika chawda');
    assert.ok(isPossibleFamilyMatch(existing, { ...payload, full_name: ' vedika   chawda ', age: 20 }));
    assert.ok(isPossibleFamilyMatch({ ...existing, full_name: 'प्रीति शर्मा' }, { ...payload, full_name: '  प्रीति  शर्मा ' }));
});
test('short and full names warn despite different demographics; unrelated people do not match', () => {
    assert.ok(isPossibleFamilyMatch({ ...existing, full_name: 'PREETI', age: 61 }, { ...payload, full_name: 'Preeti Sudhakar', age: 62 }));
    assert.equal(isPossibleFamilyMatch(existing, { ...payload, full_name: 'Ritika Chawda', age: 37 }), false);
    assert.ok(isPossibleFamilyMatch({ ...existing, full_name: 'PREETI', age: 61 }, { ...payload, full_name: 'Preeti Sudhakar', age: 9 }));
    assert.ok(isPossibleFamilyMatch(existing, { ...payload, full_name: 'vedika', age: 26, date_of_birth: '2000-02-01', relationship: 'sister' }));
    assert.ok(isPossibleFamilyMatch({ ...existing, full_name: 'vedika', age: 26 }, payload));
    assert.ok(isPossibleFamilyMatch(existing, { ...payload, full_name: 'vedika', age: 26, gender: 'male' }));
    assert.equal(isPossibleFamilyMatch(existing, { ...payload, full_name: 'Ved' }), false);
    assert.equal(isPossibleFamilyMatch(existing, { ...payload, full_name: 'Vedika Sharma' }), false);
});
test('first-name-only booking with a different DOB still requires an explicit different-person confirmation', async () => {
    const connection = fakeConnection([existing, { ...existing, family_member_id: 780, age: 11 }]);
    const shortened = { ...payload, full_name: 'vedika', age: 26, date_of_birth: '2000-02-01', relationship: 'sister' };
    let token;
    await assert.rejects(guardFamilyMemberCreation(connection, { patientId: 2960, payload: shortened }), error => {
        assert.equal(error.statusCode, 409);
        assert.deepEqual(error.details.candidates.map(member => member.family_member_id), [723, 780]);
        token = error.details.confirmation_token;
        return true;
    });
    await guardFamilyMemberCreation(connection, { patientId: 2960, payload: shortened, confirmationToken: token });
    assert.ok(connection.calls.every(call => !/INSERT|UPDATE\s+\w+\s+SET/i.test(call.sql)));
});
test('candidate check is account-scoped, locks account before members and returns existing ID with previous branch', async () => {
    const connection = fakeConnection([existing]);
    await assert.rejects(guardFamilyMemberCreation(connection, { patientId: 2960, payload }), error => {
        assert.equal(error.statusCode, 409);
        assert.equal(error.details.code, 'FAMILY_MEMBER_MATCH');
        assert.equal(error.details.candidates[0].family_member_id, 723);
        assert.equal(error.details.candidates[0].last_visit.branch_name, 'Devendra Nagar');
        return true;
    });
    assert.match(connection.calls[0].sql, /master_users.*FOR UPDATE/);
    assert.match(connection.calls[1].sql, /fk_primary_patient_id = \?.*ORDER BY id FOR UPDATE/);
    assert.deepEqual(connection.calls[1].params, [2960]);
    assert.ok(connection.calls.every(call => !/INSERT|UPDATE\s+\w+\s+SET/i.test(call.sql)));
});
test('explicit different-person confirmation works once, not after a concurrent insert or form change', async () => {
    const connection = fakeConnection([existing]);
    let token;
    try { await guardFamilyMemberCreation(connection, { patientId: 2960, payload }); } catch (error) { token = error.details.confirmation_token; }
    await guardFamilyMemberCreation(connection, { patientId: 2960, payload, confirmationToken: token });
    await assert.rejects(guardFamilyMemberCreation(connection, { patientId: 2960, payload: { ...payload, age: 10 }, confirmationToken: token }), error => error.statusCode === 409);
    await assert.rejects(guardFamilyMemberCreation(connection, { patientId: 999, payload, confirmationToken: token }), error => error.statusCode === 409);
    connection.members.push({ ...existing, ...payload, family_member_id: 780 });
    await assert.rejects(guardFamilyMemberCreation(connection, { patientId: 2960, payload, confirmationToken: token }), error => error.statusCode === 409);
});
test('a retry without confirmation never bypasses a new matching record; inactive matches are visible too', async () => {
    const connection = fakeConnection([]);
    await guardFamilyMemberCreation(connection, { patientId: 2960, payload });
    connection.members.push({ ...existing, is_active: 0 });
    await assert.rejects(guardFamilyMemberCreation(connection, { patientId: 2960, payload, confirmationToken: 'tampered' }), error => {
        assert.equal(error.details.candidates[0].is_active, 0);
        return error.statusCode === 409;
    });
});
