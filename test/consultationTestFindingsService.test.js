const test = require('node:test');
const assert = require('node:assert/strict');

const {
    normalizeTestFindingsPayload,
} = require('../services/consultationTestFindingsService');

const prescribedTests = [
    { consultation_test_id: 21, test_name: 'CBC' },
    { consultation_test_id: 22, test_name: 'Vitamin D' },
];

test('normalizes lab findings for prescribed tests without requiring every test', () => {
    const normalized = normalizeTestFindingsPayload({
        prescribedTests,
        submittedFindings: [
            { consultation_test_id: 22, finding_text: 'Vitamin D deficiency', notes: '12 ng/mL' },
        ],
    });

    assert.equal(normalized.length, 1);
    assert.deepEqual(normalized[0], {
        consultation_test_id: 22,
        finding_text: 'Vitamin D deficiency',
        notes: '12 ng/mL',
    });
});

test('clears a finding when finding_text is blank', () => {
    const normalized = normalizeTestFindingsPayload({
        prescribedTests,
        submittedFindings: [
            { consultation_test_id: 21, finding_text: '   ', notes: '' },
        ],
    });

    assert.deepEqual(normalized[0], {
        consultation_test_id: 21,
        finding_text: null,
        notes: null,
    });
});

test('rejects notes without a finding and tests that are not on the consultation', () => {
    assert.throws(
        () => normalizeTestFindingsPayload({
            prescribedTests,
            submittedFindings: [{ consultation_test_id: 21, finding_text: '', notes: 'low' }],
        }),
        /finding_text is required/
    );

    assert.throws(
        () => normalizeTestFindingsPayload({
            prescribedTests,
            submittedFindings: [{ consultation_test_id: 99, finding_text: 'x' }],
        }),
        /does not belong to this consultation/
    );
});
