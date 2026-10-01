const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeDiscounts } = require('../services/billingDiscountService');

test('billing discounts keep one audited fixed amount per category', () => {
    assert.deepEqual(normalizeDiscounts([
        { category: 'medicine', amount: '25.5', reason_code: 'doctor_approved' },
        { category: 'test', amount: 0, reason_code: '' },
    ]), [{
        category: 'MEDICINE',
        amount: 25.5,
        reason_code: 'DOCTOR_APPROVED',
        reason_note: null,
    }]);
});

test('billing discounts require reasons and reject duplicate categories', () => {
    assert.throws(
        () => normalizeDiscounts([{ category: 'MEDICINE', amount: 10 }]),
        /reason_code is required/
    );
    assert.throws(
        () => normalizeDiscounts([
            { category: 'MEDICINE', amount: 10, reason_code: 'OTHER', reason_note: 'Courtesy' },
            { category: 'medicine', amount: 5, reason_code: 'PRICE_CORRECTION' },
        ]),
        /Only one medicine discount is allowed/
    );
});

test('other billing discount requires a written reason', () => {
    assert.throws(
        () => normalizeDiscounts([{ category: 'COURIER', amount: 15, reason_code: 'OTHER' }]),
        /reason_note is required for OTHER/
    );
});

test('billing discounts allow only doctor approved or other reasons', () => {
    assert.throws(
        () => normalizeDiscounts([{ category: 'TEST', amount: 10, reason_code: 'PROMOTIONAL' }]),
        /must be DOCTOR_APPROVED or OTHER/
    );
});
