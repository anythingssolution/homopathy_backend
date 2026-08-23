const test = require('node:test');
const assert = require('node:assert/strict');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_medical_controller_secret';
process.env.DB_HOST = process.env.DB_HOST || '127.0.0.1';
process.env.DB_USER = process.env.DB_USER || 'test_user';
process.env.DB_NAME = process.env.DB_NAME || 'test_db';

const { buildMedicalPrescriptionListItemResponse } = require('../controllers/v1/medicalController');

const prescriptionRow = {
    consultation_id: 88,
    appointment_id: 77,
    workflow_status: 'READY_FOR_MEDICAL',
};

test('medical prescription list exposes quick formula input inside prescription', () => {
    const item = buildMedicalPrescriptionListItemResponse(prescriptionRow, {
        quick_formula_input: '3 + 5 + 6',
    });

    assert.equal(item.prescription.quick_formula_input, '3 + 5 + 6');
});

test('medical prescription list includes patient id for dues tracking', () => {
    const item = buildMedicalPrescriptionListItemResponse({
        ...prescriptionRow,
        patient_id: 44,
        patient_uuid: 'pat-44',
        patient_full_name: 'Test Patient',
    }, null);

    assert.equal(item.patient.patient_id, 44);
});
