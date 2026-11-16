const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeLifestyleHistory, readLifestyleHistory } = require('../utils/lifestyleHistory');

test('lifestyle answers distinguish unanswered, No, and explicit clearing', () => {
    assert.equal(normalizeLifestyleHistory(undefined), undefined);
    assert.equal(normalizeLifestyleHistory(null), null);
    assert.equal(normalizeLifestyleHistory({}), null);
    const saved = normalizeLifestyleHistory({ sleep_disturbed: 'NO', thirst: 'LARGE' });
    assert.equal(saved.sleep_disturbed, 'NO');
    assert.equal(saved.stress, null);
    assert.equal(saved.thirst, 'LARGE');
    assert.deepEqual(readLifestyleHistory(JSON.stringify(saved)), saved);
});
test('family details are trimmed and retained only with Yes', () => {
    const data = { family_history: 'YES', father_details: ' Diabetes ', mother_details: ' Thyroid ' };
    const saved = normalizeLifestyleHistory(data);
    assert.equal(saved.father_details, 'Diabetes');
    assert.equal(saved.mother_details, 'Thyroid');
    assert.equal(normalizeLifestyleHistory({ ...data, family_history: 'NO' }).father_details, '');
    assert.equal(normalizeLifestyleHistory({ ...data, family_history: null }), null);
});
test('invalid answers and unsafe payload shapes are rejected', () => {
    for (const data of [[], 'YES', { stress: false }, { thirst: 'YES' }, { periods_regular: 'MAYBE' }, { father_details: {} }, { father_details: 'x'.repeat(5001) }]) {
        assert.throws(() => normalizeLifestyleHistory(data), error => error.statusCode === 400);
    }
    assert.equal(readLifestyleHistory('bad legacy text'), null);
    assert.equal(readLifestyleHistory(null), null);
});

test('consultation API validation includes lifestyle-only detail and keeps old-client semantics', () => {
    require('dotenv').config();
    const { validateConsultationPayload } = require('../controllers/v1/doctor/shared');
    const body = { appointment_id: 1, medication_duration_days: 15, has_no_advice: true, medications: [], tests: [] };
    const answer = validateConsultationPayload({ ...body, lifestyle_history: { stress: 'NO' } });
    assert.equal(answer.lifestyleHistory.stress, 'NO');
    assert.equal(answer.lifestyleHistory.sleep_disturbed, null);
    const legacy = validateConsultationPayload({ ...body, symptoms: 'Existing history', family_history: 'Existing notes' });
    assert.equal(legacy.lifestyleHistory, undefined);
    assert.equal(legacy.familyHistory, 'Existing notes');
    const clear = validateConsultationPayload({ ...body, symptoms: 'Existing history', lifestyle_history: null });
    assert.equal(clear.lifestyleHistory, null);
});
