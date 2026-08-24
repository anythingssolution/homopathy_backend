const test = require('node:test');
const assert = require('node:assert/strict');

const {
    calculateDispensingTotal,
    ensureDispensingMutationAllowed,
    getBillableDispensingItems,
    projectDispensingStatus,
    resolveDispensingEventType,
    validatePrescribedDispensingItems,
    validatePrescribedTests,
} = require('../services/dispensaryPricingService');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_dispensary_secret';
process.env.DB_HOST = process.env.DB_HOST || '127.0.0.1';
process.env.DB_USER = process.env.DB_USER || 'test_user';
process.env.DB_NAME = process.env.DB_NAME || 'test_db';

const { authorizeModuleAccess } = require('../middleware/authMiddleware');
const { getModuleAccessFromUser } = require('../utils/moduleAccess');

const prescribedMedications = [
    { consultation_medication_id: 11, medicine_value: 'ARNICA 30' },
    { consultation_medication_id: 12, medicine_value: 'BELLADONNA 200' },
];

test('dispensary overlay keeps every Doctor medicine while safely voiding one', () => {
    const normalized = validatePrescribedDispensingItems({
        prescribedMedications,
        existingItems: [],
        submittedItems: [
            { consultation_medication_id: 11, medicine_value: 'ARNICA 30', amount: 120, version: 0 },
            {
                consultation_medication_id: 12,
                medicine_value: 'BELLADONNA 200',
                amount: 80,
                dispense_status: 'VOID',
                void_reason: 'Patient already has this medicine',
                version: 0,
            },
        ],
    });

    assert.deepEqual(normalized.map((item) => ({
        id: item.consultation_medication_id,
        status: item.dispense_status,
        reason: item.void_reason,
    })), [
        { id: 11, status: 'ACTIVE', reason: null },
        { id: 12, status: 'VOID', reason: 'Patient already has this medicine' },
    ]);
});

test('voided Doctor medicine requires a removal reason', () => {
    assert.throws(
        () => validatePrescribedDispensingItems({
            prescribedMedications: [prescribedMedications[0]],
            existingItems: [],
            submittedItems: [{
                consultation_medication_id: 11,
                medicine_value: 'ARNICA 30',
                amount: 120,
                dispense_status: 'VOID',
                version: 0,
            }],
        }),
        (error) => error.statusCode === 400 && /Removal reason is required/.test(error.message)
    );
});

test('foreign, duplicate, and mismatched Doctor medicine ids are rejected', () => {
    const base = {
        prescribedMedications: [prescribedMedications[0]],
        existingItems: [],
    };

    assert.throws(
        () => validatePrescribedDispensingItems({
            ...base,
            submittedItems: [{ consultation_medication_id: 99, medicine_value: 'ARNICA 30', amount: 100 }],
        }),
        /does not belong/
    );
    assert.throws(
        () => validatePrescribedDispensingItems({
            ...base,
            submittedItems: [
                { consultation_medication_id: 11, medicine_value: 'ARNICA 30', amount: 100 },
                { consultation_medication_id: 11, medicine_value: 'ARNICA 30', amount: 100 },
            ],
        }),
        /Duplicate/
    );
    assert.throws(
        () => validatePrescribedDispensingItems({
            ...base,
            submittedItems: [{ consultation_medication_id: 11, medicine_value: 'Changed name', amount: 100 }],
        }),
        /does not match/
    );
});

test('stale dispensing item version is rejected with conflict', () => {
    assert.throws(
        () => validatePrescribedDispensingItems({
            prescribedMedications: [prescribedMedications[0]],
            existingItems: [{
                pricing_item_id: 51,
                consultation_medication_id: 11,
                medicine_value: 'ARNICA 30',
                amount: 100,
                dispense_status: 'ACTIVE',
                version: 3,
            }],
            submittedItems: [{
                consultation_medication_id: 11,
                medicine_value: 'ARNICA 30',
                amount: 110,
                version: 2,
            }],
        }),
        (error) => error.statusCode === 409 && /changed by another user/.test(error.message)
    );
});

test('server total includes only active dispensing items plus additional medicines and tests', () => {
    const total = calculateDispensingTotal({
        prescribedItems: [
            { amount: 100.10, dispense_status: 'ACTIVE' },
            { amount: 90, dispense_status: 'VOID' },
        ],
        additionalItems: [{ amount: 25.20 }],
        tests: [{ amount: 50.30 }],
    });

    assert.equal(total, 175.60);
    assert.deepEqual(
        getBillableDispensingItems([
            { id: 1, dispense_status: 'ACTIVE' },
            { id: 2, dispense_status: 'VOID' },
        ]).map((item) => item.id),
        [1]
    );
});

test('server total excludes voided tests', () => {
    const total = calculateDispensingTotal({
        prescribedItems: [{ amount: 100, dispense_status: 'ACTIVE' }],
        additionalItems: [],
        tests: [
            { amount: 50.30, dispense_status: 'ACTIVE' },
            { amount: 80, dispense_status: 'VOID' },
        ],
    });

    assert.equal(total, 150.30);
});

test('dispensary can void a prescribed test only when a removal reason is given', () => {
    const prescribedTests = [
        { consultation_test_id: 21, test_name: 'CBC', amount: 50.30, version: 1 },
        { consultation_test_id: 22, test_name: 'ESR', amount: 80, version: 1 },
    ];

    const normalized = validatePrescribedTests({
        prescribedTests,
        submittedTests: [
            { consultation_test_id: 21, dispense_status: 'ACTIVE', version: 1 },
            {
                consultation_test_id: 22,
                dispense_status: 'VOID',
                void_reason: 'Patient already completed this test outside',
                version: 1,
            },
        ],
    });

    assert.deepEqual(normalized.map((item) => ({
        id: item.consultation_test_id,
        status: item.dispense_status,
        reason: item.void_reason,
    })), [
        { id: 21, status: 'ACTIVE', reason: null },
        { id: 22, status: 'VOID', reason: 'Patient already completed this test outside' },
    ]);

    assert.throws(
        () => validatePrescribedTests({
            prescribedTests,
            submittedTests: [
                { consultation_test_id: 21, dispense_status: 'ACTIVE', version: 1 },
                { consultation_test_id: 22, dispense_status: 'VOID', version: 1 },
            ],
        }),
        (error) => error.statusCode === 400 && /Removal reason is required/.test(error.message)
    );
});

test('prescription projection keeps the clinical medicine and exposes void status and reason', () => {
    const clinicalMedicine = {
        consultation_medication_id: 11,
        medicine_value: 'ARNICA 30',
        remark: 'Doctor instruction',
        doses: [{ dose_label: 'MORNING', balls_per_dose: 4 }],
    };
    const projected = projectDispensingStatus(clinicalMedicine, {
        dispense_status: 'VOID',
        void_reason: 'Patient already has this medicine',
        voided_by: 7,
        voided_at: '2026-08-04 10:30:00',
        version: 3,
    });

    assert.deepEqual(projected, {
        ...clinicalMedicine,
        dispense_status: 'VOID',
        void_reason: 'Patient already has this medicine',
        voided_by: 7,
        voided_at: '2026-08-04 10:30:00',
        dispensing_version: 3,
    });
});

test('active or unpriced prescription medicines remain visually normal in the projection', () => {
    const medicine = { consultation_medication_id: 12, medicine_value: 'BELLADONNA 200' };

    assert.deepEqual(projectDispensingStatus(medicine, { dispense_status: 'ACTIVE', version: 1 }), {
        ...medicine,
        dispense_status: 'ACTIVE',
        void_reason: null,
        voided_by: null,
        voided_at: null,
        dispensing_version: 1,
    });
    assert.deepEqual(projectDispensingStatus(medicine), {
        ...medicine,
        dispense_status: null,
        void_reason: null,
        voided_by: null,
        voided_at: null,
        dispensing_version: null,
    });
});

test('price, void, restore and reason changes produce auditable event types', () => {
    const existing = { amount: 100, dispense_status: 'ACTIVE', void_reason: null };

    assert.equal(resolveDispensingEventType({ existing, amount: 110, dispenseStatus: 'ACTIVE' }), 'PRICE_UPDATED');
    assert.equal(resolveDispensingEventType({ existing, amount: 100, dispenseStatus: 'VOID', voidReason: 'Not needed' }), 'VOIDED');
    assert.equal(resolveDispensingEventType({
        existing: { amount: 100, dispense_status: 'VOID', void_reason: 'Not needed' },
        amount: 100,
        dispenseStatus: 'ACTIVE',
    }), 'RESTORED');
});

test('processed and paid dispensing mutations are locked', () => {
    assert.throws(
        () => ensureDispensingMutationAllowed({ workflowStatus: 'PROCESSED_BY_MEDICAL', hasPaidBill: false }),
        (error) => error.statusCode === 409 && /medical-ready/.test(error.message)
    );
    assert.throws(
        () => ensureDispensingMutationAllowed({ workflowStatus: 'READY_FOR_MEDICAL', hasPaidBill: true }),
        (error) => error.statusCode === 409 && /Paid or partially paid/.test(error.message)
    );
});

test('Medical module authorization grants Doctor and Medical but denies unrelated roles', () => {
    const authorize = authorizeModuleAccess('MEDICAL');
    const authorizeRole = (roleCode, hasCrossModuleAccess = 0) => {
        let nextError = 'not-called';
        authorize({ user: { role_code: roleCode, has_cross_module_access: hasCrossModuleAccess } }, {}, (error) => {
            nextError = error || null;
        });
        return nextError;
    };

    assert.equal(authorizeRole('DOC'), null);
    assert.equal(authorizeRole('MED'), null);
    assert.equal(authorizeRole('PAT')?.statusCode, 403);
    assert.equal(authorizeRole('REC')?.statusCode, 403);
    assert.equal(authorizeRole('REC', 1), null);

    assert.deepEqual(getModuleAccessFromUser({ role_code: 'DOC' }), {
        has_cross_module_access: 0,
        can_access_reception_module: 0,
        can_access_medical_module: 1,
    });
});
