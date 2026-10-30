const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const AppError = require('../utils/AppError');
const { normalizeOptionalAddressFields } = require('../utils/patientAddressFields');
const age = require('../utils/age');

function fixture(role, branchAllowed = true) {
    let patient = { id: 7, uuid: 'DTH7', full_name: 'Fixture', mobile_no: '9876543210', gender: 'male', age: 30,
        role: 'PAT', is_active: 1, area_name: 'Mowa', ward_no: '4', vidhan_sabha: 'Raipur North', city: 'Raipur', pincode: '492001' };
    const member = { id: 8, full_name: 'Dependent', gender: 'female', age: 20 };
    const audits = [], writes = [];
    const connection = { execute: async (sql, values = []) => {
        if (sql.includes('SELECT') && sql.includes('FROM master_users')) return [[{ ...patient, patient_id: patient.id }]];
        if (sql.includes('FROM tbl_appointments')) return [branchAllowed ? [{ appointment_id: 1 }] : []];
        if (sql.includes('FROM tbl_patient_family_members')) return [[{ ...member }]];
        if (sql.includes('UPDATE master_users')) {
            writes.push(sql);
            const columns = [...sql.matchAll(/([a-z_]+)\s*=\s*\?/g)].map(m => m[1]);
            columns.slice(0, -1).forEach((column, i) => { patient[column] = values[i]; });
            return [{ affectedRows: 1 }];
        }
        if (sql.includes('INSERT INTO log_user_profile_updates')) { audits.push(values); return [{ insertId: 1 }]; }
        throw new Error(`Unexpected query: ${sql}`);
    }};
    const shared = { AppError, asyncHandler: fn => fn, toPositiveInt: v => Number(v) > 0 ? Number(v) : null,
        withTransaction: async fn => { const previous = { ...patient }; try { return await fn(connection); } catch (error) { patient = previous; throw error; } } };
    let source, handler;
    if (role === 'doctor') {
        source = fs.readFileSync(require.resolve('../controllers/v1/doctor/patientUpdateController'), 'utf8');
        const module = { exports: {} };
        vm.runInNewContext(source, { module, require: name => name === './shared' ? shared : name.endsWith('/age') ? age : { normalizeOptionalAddressFields } });
        handler = module.exports.updateDoctorPatient;
    } else {
        source = fs.readFileSync(require.resolve('../controllers/v1/receptionistController'), 'utf8');
        const start = source.indexOf('const updateReceptionistPatient =');
        const end = source.indexOf('const listReceptionistPatientUpdateHistory =', start);
        handler = vm.runInNewContext(`${source.slice(start, end)}; updateReceptionistPatient`, { ...shared,
            normalizeOptionalAddressFields, validateGender: () => true, validateMobile: () => true,
            getClientIp: () => '127.0.0.1', PATIENT_ROLE: 'PAT' });
    }
    return { audits, writes, patient: () => patient, call: async body => {
        let result;
        const res = { status: () => res, json: value => { result = value; } };
        await handler({ params: { patient_id: 7 }, selectedBranchId: 1, user: { id: 2, role }, body, headers: {} }, res);
        return result;
    }};
}
for (const role of ['doctor', 'reception']) {
    test(`${role}: state saves, returns, audits, survives unrelated edits and clears`, async () => {
        const f = fixture(role);
        const saved = await f.call({ state_name: ' Chhattisgarh ' });
        assert.equal(saved.data.patient.state_name, 'Chhattisgarh');
        assert.equal(f.patient().address, 'Mowa, Ward 4, Raipur North, 492001, Raipur, Chhattisgarh');
        assert.ok(JSON.parse(f.audits.at(-1)[5]).includes('state_name'));
        await f.call({ full_name: 'Updated name' });
        assert.equal(f.patient().state_name, 'Chhattisgarh');
        await f.call({ state_name: '' });
        assert.equal(f.patient().state_name, null);
        assert.equal(f.patient().address, 'Mowa, Ward 4, Raipur North, 492001, Raipur');
        for (const state_name of [123, {}, 'x'.repeat(101)]) {
            const invalid = fixture(role);
            await assert.rejects(invalid.call({ state_name }), { statusCode: 400 });
            assert.equal(invalid.writes.length, 0);
        }
    });
    test(`${role}: ward / assembly persist, return in response, audit and preserve unrelated fields`, async () => {
        const f = fixture(role);
        const response = await f.call({ ward_no: ' 12 ', vidhan_sabha: ' Raipur West ' });
        assert.equal(response.data.patient.ward_no, '12');assert.equal(response.data.patient.vidhan_sabha, 'Raipur West');
        assert.equal(f.patient().address, 'Mowa, Ward 12, Raipur West, 492001, Raipur');
        assert.equal(f.patient().full_name, 'Fixture');assert.equal(f.patient().uuid, 'DTH7');
        assert.deepEqual(JSON.parse(f.audits[0][5]), ['ward_no', 'vidhan_sabha']);
        await f.call({ full_name: 'New name' });assert.equal(f.patient().ward_no, '12');
        await f.call({ ward_no: '', vidhan_sabha: null });assert.equal(f.patient().ward_no, null);
        assert.equal(f.patient().address, 'Mowa, 492001, Raipur');
        const writeCount = f.writes.length;
        await assert.rejects(f.call({ ward_no: '', vidhan_sabha: null }), { statusCode: 400 });
        assert.equal(f.writes.length, writeCount);
    });
    test(`${role}: invalid values and branch mismatch reject before writes`, async () => {
        for (const body of [{ ward_no: 'x'.repeat(51) }, { vidhan_sabha: 'x'.repeat(151) }, { ward_no: {} }]) {
            const f = fixture(role);await assert.rejects(f.call(body), { statusCode: 400 });assert.equal(f.writes.length, 0);
        }
        const f = fixture(role, false);await assert.rejects(f.call({ ward_no: '12' }), error => error.statusCode >= 400);
        assert.equal(f.writes.length, 0);
    });
}
test('doctor dependent edit updates only shared account address and leaves dependent identity intact', async () => {
    const f = fixture('doctor');
    const response = await f.call({ family_member_id: 8, ward_no: '10', vidhan_sabha: '' });
    assert.equal(response.data.entity_type, 'FAMILY_MEMBER');assert.equal(response.data.patient.full_name, 'Dependent');
    assert.equal(response.data.patient.ward_no, '10');assert.equal(response.data.patient.vidhan_sabha, null);
    assert.equal(f.patient().full_name, 'Fixture');assert.equal(f.patient().address, 'Mowa, Ward 10, 492001, Raipur');
});
