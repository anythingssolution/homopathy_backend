const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveRepeatMedicineAmount: resolve } = require('../utils/repeatMedicinePricing');

const product = (name, rate, packing = null) => ({ product_name: name, mrp_rate: rate, packing, is_active: 1 });
const medicine = (value, type = 'TEXT') => ({ medicine_value: value, medicine_type: type, last_amount: 300 });

test('RD 63 repeat uses latest master price times saved quantity and preserves historical amount', () => {
    const row = medicine('Rd 63 Uterine Fibroids Drop * 2');
    assert.equal(resolve(row, [product('RD 63 UTERINE FIBROIDS DROP', 180)]), 360);
    assert.equal(row.last_amount, 300);
    assert.equal(resolve(row, [product('RD 63 UTERINE FIBROIDS DROP', 200)]), 400);
});

test('matches exact packing, handles names containing separators and spacing', () => {
    const products = [product('AD PRO - VITAMIN SHAMPOO', 270, '200 ML'), product('AD PRO - VITAMIN SHAMPOO', 150, '100 ML')];
    assert.equal(resolve(medicine('AD PRO - VITAMIN SHAMPOO - 200 ml * 2'), products), 540);
    assert.equal(resolve(medicine('2 x BT  PICRONETT DROP - 30 ml'), [product('BT PICRONETT DROP', 188, '30 ML')]), 376);
});

test('doctor manual products also use current master rates; numeric medicines retain saved pricing', () => {
    const products = [{ ...product('MANUAL DROP', 120, '30 ML'), source_type: 'DOCTOR_MANUAL' }];
    assert.equal(resolve({ ...medicine('MANUAL DROP - 30 ML'), is_manual_entry: 1 }, products), 120);
    assert.equal(resolve(medicine('MANUAL DROP - 30 ML', 'NUMERIC'), products), 300);
});

test('unmatched, inactive, zero-priced and conflicting products retain saved amount', () => {
    const row = medicine('DROP');
    for (const products of [[], [product('OTHER', 180)], [{ ...product('DROP', 180), is_active: 0 }], [product('DROP', 0)], [product('DROP', 100, '30 ML'), product('DROP', 200, '100 ML')]]) {
        assert.equal(resolve(row, products), 300);
    }
    assert.equal(resolve(medicine('DROP - 50 ML'), [product('DROP', 180, '30 ML')]), 300);
});
