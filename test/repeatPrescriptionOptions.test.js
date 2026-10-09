const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { resolveRepeatMedicineAmount } = require('../utils/repeatMedicinePricing');

async function load(includePrevious, count = 2) {
    const calls = [];
    const source = fs.readFileSync(path.join(__dirname, '../controllers/v1/medicalController.js'), 'utf8');
    const start = source.indexOf('const getRepeatMedicineLastPrescription =');
    const end = source.indexOf('const createRepeatMedicineBillController =', start);
    const query = async (sql, params) => {
        calls.push({ sql, params });
        if (sql.includes('FROM master_users')) return [{ patient_id: 7 }];
        if (sql.includes('FROM tbl_consultations')) return [{ consultation_id: 20 }, { consultation_id: 19 }].slice(0, includePrevious ? count : 1);
        if (sql.includes('FROM tbl_consultation_medications cm')) return params.map((id) => ({ consultation_id: id, consultation_medication_id: id * 10, medicine_type: id === 20 ? 'TEXT' : 'NUMERIC', medicine_value: id === 20 ? 'DROP * 2' : '14/6', last_amount: 300 }));
        if (sql.includes('FROM master_medical_products')) return [{ product_name: 'DROP', mrp_rate: 180, is_active: 1 }];
        throw new Error('Unexpected query');
    };
    const handler = vm.runInNewContext(`${source.slice(start, end)}; getRepeatMedicineLastPrescription`, {
        query, asyncHandler: (fn) => fn, toPositiveInt: Number, AppError: Error,
        decorateTokenFields: (value) => value, resolveRepeatMedicineAmount,
        getPatientMedicationOutstanding: async () => ({ total_pending: 25 }),
    });
    let response;
    const res = { status: () => res, json: (value) => { response = value; } };
    await handler({ params: { patient_id: 7 }, selectedBranchId: 2, query: includePrevious ? { include_previous: '1' } : {} }, res);
    return { calls, data: response.data };
}

test('existing last-prescription response stays latest-only by default', async () => {
    const { calls, data } = await load(false);
    assert.equal(data.prescription.consultation_id, 20);
    assert.equal(data.prescriptions, undefined);
    assert.match(calls[1].sql, /LIMIT 1/);
    assert.deepEqual(Array.from(calls[1].params), [7, 2]);
});

test('optional previous prescription keeps medicine groups and pricing separate', async () => {
    const { calls, data } = await load(true);
    assert.match(calls[1].sql, /LIMIT 2/);
    assert.equal(data.prescription.consultation_id, 20);
    assert.equal(data.prescriptions.length, 2);
    assert.equal(data.prescriptions[0].medications[0].consultation_medication_id, 200);
    assert.equal(data.prescriptions[0].medications[0].repeat_amount, 360);
    assert.equal(data.prescriptions[1].medications[0].consultation_medication_id, 190);
    assert.equal(data.prescriptions[1].medications[0].repeat_amount, 300);
    assert.equal(data.account_dues.total_pending, 25);
});

test('one prescription still works when previous is requested', async () => {
    const { data } = await load(true, 1);
    assert.equal(data.prescriptions.length, 1);
    assert.equal(data.prescription.consultation_id, 20);
});
