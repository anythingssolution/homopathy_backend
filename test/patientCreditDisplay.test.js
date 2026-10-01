const test = require('node:test');
const assert = require('node:assert/strict');

process.env.JWT_SECRET ||= 'patient-credit-display-test-secret';
process.env.DB_HOST ||= '127.0.0.1';
process.env.DB_USER ||= 'test';
process.env.DB_NAME ||= 'test';

const { mapOutstandingBill } = require('../services/patientCreditService');

const baseRow = {
    bill_id: 1,
    bill_type: 'MEDICATION',
    patient_id: 10,
    total_amount: 100,
    paid_amount: 0,
    pending_amount: 100,
};

test('outstanding medicine bills keep direct and repeat labels distinct', () => {
    const direct = mapOutstandingBill({
        ...baseRow,
        consultation_id: null,
        appointment_id: null,
        is_direct_medicine: 1,
    });
    const repeat = mapOutstandingBill({
        ...baseRow,
        bill_id: 2,
        consultation_id: 20,
        appointment_id: null,
        is_direct_medicine: 0,
    });

    assert.equal(direct.treatment_name, 'Direct Medicine');
    assert.equal(direct.is_direct_medicine, true);
    assert.equal(repeat.treatment_name, 'Repeat Medicine');
    assert.equal(repeat.is_direct_medicine, false);
    assert.equal(repeat.is_repeat_medicine, true);
});
