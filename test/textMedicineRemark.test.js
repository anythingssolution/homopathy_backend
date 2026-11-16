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
            if (sql.includes('FROM master_medical_products')) return [[]];
            return [{ affectedRows: 1 }];
        },
    };

    await upsertDoctorManualVariant(connection, 934, '22M 2D', 'N/A', 85);

    assert.equal(calls.length, 2);
    assert.equal(calls[1].params[2], 'N/A');
    assert.equal(calls[1].params[3], 85);
});

test('a name-only manual medicine gets a product with unspecified packing and unknown price', async () => {
    const calls = [];
    const connection = { execute: async (sql, params) => {
        calls.push({ sql, params });
        return sql.includes('FROM master_medical_products') ? [[]] : [{ affectedRows: 1 }];
    } };
    await upsertDoctorManualVariant(connection, 1004, 'BT ANTI DANDRUFF OIL + 74Q', '', null);
    assert.match(calls[1].sql, /INSERT INTO master_medical_products/);
    assert.deepEqual(calls[1].params.slice(0, 4), [1004, 'BT ANTI DANDRUFF OIL + 74Q', 'N/A', null]);
    assert.doesNotMatch(calls[1].sql.split('ON DUPLICATE KEY UPDATE')[1], /is_active\s*=\s*1/);
});

test('saving a stale manual name cannot restore its deleted product or invent a replacement variant', async () => {
    const calls = [];
    const connection = { execute: async (sql, params) => {
        calls.push({ sql, params });
        return [[{ id: 44, medicine_text_id: 1004, source_type: 'DOCTOR_MANUAL',
            product_name: 'BT ANTI DANDRUFF OIL + 74Q', normalized_product_name: 'bt anti dandruff oil + 74q',
            packing: '100 ML', size_or_weight: null, is_active: 0 }]];
    } };
    await upsertDoctorManualVariant(connection, 1004, 'BT ANTI DANDRUFF OIL + 74Q', '100 ML', 200);
    await upsertDoctorManualVariant(connection, 1004, 'BT ANTI DANDRUFF OIL + 74Q', '', 200);
    assert.equal(calls.length, 2);
    assert.ok(calls.every(call => !/INSERT|UPDATE/.test(call.sql)));
});

test('a deleted variant stays deleted when another packing of the same medicine is still active', async () => {
    const rows = [
        { id: 1, product_name: 'DROP', packing: '100 ML', is_active: 0, source_type: 'DOCTOR_MANUAL' },
        { id: 2, product_name: 'DROP', packing: '200 ML', is_active: 1, source_type: 'DOCTOR_MANUAL' },
    ];
    const calls = [];
    const connection = { execute: async (sql, params) => { calls.push({ sql, params }); return [rows]; } };
    await upsertDoctorManualVariant(connection, 1, 'DROP', '100 ML', 200);
    assert.equal(calls.length, 1);
});

test('manual product master skips an existing product variant across sources', async () => {
    const calls = [];
    const connection = {
        execute: async (sql, params) => {
            calls.push({ sql, params });
            if (String(sql).includes('FROM master_medical_products')) {
                return [[{
                    id: 209,
                    source_type: 'MEDICAL_PRODUCT_PRICE',
                    product_name: 'DT 111/25 TAB',
                    normalized_product_name: 'dt 111/25 tab',
                    packing: '30 TABS',
                    size_or_weight: null,
                    is_active: 1,
                }]];
            }
            return [{ affectedRows: 1 }];
        },
    };

    await upsertDoctorManualVariant(connection, 209, 'DT 111/25 TAB', '30 TAB', 250);

    assert.equal(calls.length, 1);
    assert.match(calls[0].sql, /FROM master_medical_products/);
});
