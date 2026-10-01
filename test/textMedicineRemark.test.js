const test = require('node:test');
const assert = require('node:assert/strict');
require('dotenv').config();

const {
    buildTextMedicineSuggestionKeyFromMedication,
} = require('../controllers/v1/doctor/shared');

test('text medicine remark key uses the selected master product and variant without quantity', () => {
    assert.deepEqual(
        buildTextMedicineSuggestionKeyFromMedication({
            medicine_type: 'TEXT',
            medicine_value: 'ECHINETT SYRUP - 200 ML * 2',
            master_medicine_value: 'ECHINETT SYRUP',
            variant_value: '200 ML',
        }),
        {
            medicine_value: 'ECHINETT SYRUP',
            variant_value: '200 ML',
            selection_value: 'ECHINETT SYRUP - 200 ML',
            normalized_medicine_value: 'echinett syrup',
            normalized_variant_value: '200 ml',
            normalized_selection_value: 'echinett syrup - 200 ml',
        },
    );
});

test('text medicine remark key remains compatible with an older formatted payload', () => {
    const key = buildTextMedicineSuggestionKeyFromMedication({
        medicine_type: 'TEXT',
        medicine_value: 'ECHINETT SYRUP - 200 ML * 3',
    });

    assert.equal(key.medicine_value, 'ECHINETT SYRUP');
    assert.equal(key.variant_value, '200 ML');
    assert.equal(key.normalized_selection_value, 'echinett syrup - 200 ml');
});
