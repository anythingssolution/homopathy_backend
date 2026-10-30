const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const AppError = require('../utils/AppError');
const { normalizeOptionalAddressFields } = require('../utils/patientAddressFields');
const { normalizeAgePayload } = require('../utils/age');

// Exercise the production handlers with isolated persistence and no OTP/WhatsApp side effects.
for (const [file, name] of [['authController', 'registerUser'], ['staffPatientController', 'createStaffPatient']]) {
    test(`${name}: state is saved with matching SQL parameters and returned by the read path`, async () => {
        const source = fs.readFileSync(require.resolve(`../controllers/v1/${file}`), 'utf8');
        const start = source.indexOf(`const ${name} =`);
        const end = source.indexOf('\nconst ', start + 7);
        const writes = [];
        let patient;
        const connection = { execute: async (sql, params = []) => {
            assert.equal((sql.match(/\?/g) || []).length, params.length);
            if (!sql.includes('INSERT INTO master_users')) return [[]];
            writes.push(sql);
            const fields = sql.match(/\(([^)]+)\)\s*VALUES/s)[1].split(',').map(v => v.trim());
            const values = sql.match(/VALUES\s*\(([^)]+)\)/s)[1].split(',').map(v => v.trim());
            assert.equal(fields.length, values.length);
            let i = 0;
            patient = { id: 7 };
            fields.forEach((field, index) => {
                if (values[index] === '?') patient[field] = params[i++];
            });
            return [{ insertId: 7 }];
        }};
        const globals = {
            asyncHandler: fn => fn, AppError, normalizeAgePayload, normalizeOptionalAddressFields,
            normalizeOptionalText: v => v == null ? null : String(v).trim() || null,
            validateEmail: () => true, validateGender: () => true, validateMobile: () => true,
            verifyRegistrationToken: () => ({ purpose: 'register_verified', mobile_no: '9999999999' }),
            verifyStaffRegistrationToken: () => {}, getClientIp: () => '127.0.0.1',
            bcrypt: { hash: async () => 'test-hash' }, randomUUID: () => 'test-random',
            generatePatientUuid: async () => 'DTH_TEST', withTransaction: fn => fn(connection),
            query: async () => [patient], buildAgeDisplaySql: () => 'NULL',
            issueAuthTokens: async () => ({}), sendRegistrationWelcomeWhatsApp: async () => {},
            buildAuthData: async ({ patient }) => patient, mapPatientRow: row => row,
            creatorRoleSelect: 'NULL', PATIENT_ROLE: 'PAT',
        };
        const mappingStart = source.indexOf('const mapPatientRow =');
        const mapping = name === 'createStaffPatient' ? source.slice(mappingStart, start) : '';
        const handler = vm.runInNewContext(`${mapping}${source.slice(start, end)}; ${name}`, globals);
        const body = { full_name: 'State fixture', age: 25, gender: 'female', mobile_no: '9999999999',
            password: 'test-only', registration_token: 'verified-test', address: 'Mowa', city: 'Raipur',
            pincode: '492001', state_name: ' Chhattisgarh ' };
        let response;
        const res = { status() { return this; }, json(value) { response = value; } };
        await handler({ body, user: { id: 2 }, headers: {} }, res);
        assert.equal(writes.length, 1);
        assert.equal(patient.state_name, 'Chhattisgarh');
        assert.ok(patient.address.endsWith(', Raipur, Chhattisgarh'));
        assert.equal(response.data.state_name, 'Chhattisgarh');
    });
}
