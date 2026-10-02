const test = require('node:test');
const assert = require('node:assert/strict');
require('dotenv').config();

const {
    buildTextMedicineSuggestionKeyFromMedication,
    buildConsistentHistoricalManualProducts,
    upsertDoctorManualVariant,
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

test('historical manual products expose a price only when every saved unit price agrees', () => {
    const products = buildConsistentHistoricalManualProducts([
        { medicine_value: '2MP/6 - 15 DAYS FOR PAIN', amount: 120 },
        { medicine_value: '2MP/6 - 15 DAYS FOR PAIN * 2', amount: 240 },
        { medicine_value: 'CUSTOM DROP - 1 WEEK', amount: 100 },
        { medicine_value: 'CUSTOM DROP - 1 WEEK', amount: 120 },
        { medicine_value: 'NO VARIANT MEDICINE', amount: 80 },
    ]);

    const consistent = products.find((product) => product.medicine_value === '2MP/6');
    assert.equal(consistent.historical_unit_price, 120);
    assert.equal(consistent.historical_price_conflict, false);

    const conflicting = products.find((product) => product.medicine_value === 'CUSTOM DROP');
    assert.equal(conflicting.historical_unit_price, null);
    assert.equal(conflicting.historical_price_conflict, true);

    const noVariant = products.find((product) => product.medicine_value === 'NO VARIANT MEDICINE');
    assert.equal(noVariant.variant_value, '');
    assert.equal(noVariant.historical_unit_price, 80);
});

test('manual medicine without a visible variant can retain its default price', async () => {
    const calls = [];
    const connection = {
        execute: async (sql, params) => {
            calls.push({ sql, params });
            return [{ affectedRows: 1 }];
        },
    };

    await upsertDoctorManualVariant(connection, 934, '22M 2D', 'N/A', 85);

    assert.equal(calls.length, 1);
    assert.equal(calls[0].params[2], 'N/A');
    assert.equal(calls[0].params[3], 85);
});
