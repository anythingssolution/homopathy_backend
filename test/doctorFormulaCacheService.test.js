const test = require('node:test');
const assert = require('node:assert/strict');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_doctor_formula_secret';
process.env.DB_HOST = process.env.DB_HOST || '127.0.0.1';
process.env.DB_USER = process.env.DB_USER || 'test_user';
process.env.DB_NAME = process.env.DB_NAME || 'test_db';

const { parseQuickFormulaInput } = require('../services/doctorFormulaCacheService');

const doseRows = [
    { dose_label: 'MORNING', sort_order: 1, times_per_day: 1, balls_per_dose: 4, instructions: '' },
];

const snapshot = {
    rules: {
        plain_number: {
            amount_strategy: 'FIXED',
            fixed_amount: 80,
            multiplier_value: null,
            template_code: 'DEFAULT',
            doses: doseRows,
        },
    },
    alpha_codes: {
        Q: {
            fixed_amount: 80,
            template_code: 'Q',
            duration_override_days: null,
            doses: doseRows,
        },
    },
};

test('numeric formula treats plain and inline-alpha medicines as separate medicines', () => {
    const result = parseQuickFormulaInput({ rawInput: '43,43Q', snapshot });

    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.entries.map((entry) => entry.medicine_value), ['43', '43Q']);
});

test('numeric formula still blocks exact duplicate medicine values', () => {
    const result = parseQuickFormulaInput({ rawInput: '43Q,43Q', snapshot });

    assert.equal(result.entries.length, 1);
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].message, 'Duplicate medicine 43Q is not allowed');
});
