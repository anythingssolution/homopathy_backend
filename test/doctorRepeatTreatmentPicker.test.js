const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
process.env.JWT_SECRET = 'repeat-treatment-options-test';
process.env.DB_HOST = '127.0.0.1'; process.env.DB_USER = 'test'; process.env.DB_NAME = 'test';
const AppError = require('../utils/AppError');
const db = require('../config/db');
let sqlCall;
db.query = async (sql, params) => { sqlCall = { sql, params }; return []; };
const { listRepeatTreatmentSources } = require('../services/followupService');

test('last-three lookup scopes to the same family subject, excludes current/future/incomplete visits and medical-only records', async () => {
  await listRepeatTreatmentSources({ appointment_id: 300, fk_patient_id: 7, fk_patient_family_member_id: 11, parent_appointment_id: 100,
    appointment_date: '2026-10-22', actual_started_at: '2026-10-22 12:00:00' });
  assert.match(sqlCall.sql, /a\.fk_patient_id = \? AND a\.appointment_id <> \?/);
  assert.match(sqlCall.sql, /a\.fk_patient_family_member_id <=> \?/);
  assert.match(sqlCall.sql, /a\.is_active = 1 AND a\.status = 'Completed'/);
  assert.match(sqlCall.sql, /a\.appointment_date <= \?/);
  assert.match(sqlCall.sql, /<= COALESCE\(\?, NOW\(\)\)/);
  assert.match(sqlCall.sql, /EXISTS[\s\S]*added_by_role[\s\S]*<> 'MEDICAL'/);
  assert.match(sqlCall.sql, /ORDER BY consulted_at DESC, c\.id DESC LIMIT 3/);
  assert.deepEqual(sqlCall.params, [100, 7, 300, '2026-10-22', '2026-10-22 12:00:00', 11]);
});
test('account-holder prescription lookup excludes all family members without restricting historical clinic branch', async () => {
  await listRepeatTreatmentSources({ appointment_id: 300, fk_patient_id: 7, appointment_date: '2026-10-22' });
  assert.match(sqlCall.sql, /a\.fk_patient_family_member_id <=> \?/);
  assert.doesNotMatch(sqlCall.sql, /a\.fk_branch_id = \?/);
  assert.deepEqual(sqlCall.params, [null, 7, 300, '2026-10-22', null, null]);
});

function controller({ count = 3, visitType = 'FOLLOW_UP_VISIT', missing = false } = {}) {
  const source = fs.readFileSync(path.join(__dirname, '../controllers/v1/doctor/consultationController.js'), 'utf8');
  const start = source.indexOf('const getRepeatTreatmentAppointment =');
  const end = source.indexOf('const normalizeSequenceNumber =', start);
  const calls = [];
  const handlers = vm.runInNewContext(`${source.slice(start, end)}; ({ getRepeatTreatmentOptions, getRepeatTreatmentDraft })`, {
    asyncHandler: fn => fn, AppError,
    getVisitTypeCode: () => visitType,
    getDoctorAppointmentById: async (id, branch) => { calls.push({ kind: 'appointment', id, branch }); return missing ? null : { appointment_id: id, fk_patient_id: 7, fk_treatment_id: 2 }; },
    listRepeatTreatmentSources: async () => [20, 19, 18].slice(0, count).map(id => ({ consultation_id: id, appointment_id: id * 10, branch_name: 'Sample Clinic', is_linked_parent: id === 19 ? 1 : 0 })),
    findRepeatTreatmentSourceAppointmentId: async () => 190,
    getConsultationAggregateByAppointmentId: async id => {
      calls.push({ kind: 'aggregate', id });
      return { consultation_id: id / 10, appointment_id: id, medication_duration_days: 15, symptoms: 'Previous complaint', diagnosis: 'Previous diagnosis', quick_formula_input: '36q', universal_remark: 'Review after 15 days', medications: [
        { consultation_medication_id: 1, medicine_type: 'NUMERIC', medicine_value: String(id), doses: [{ dose_label: 'MORNING', balls_per_dose: 5 }] },
        { consultation_medication_id: 2, medicine_type: 'TEXT', medicine_value: 'Manual medicine * 2', remark: 'After food', is_manual_entry: 1, added_by_role: 'DOCTOR' },
        { consultation_medication_id: 3, medicine_type: 'TEXT', medicine_value: 'Medical addition', added_by_role: 'MEDICAL' },
      ] };
    },
    getMedicalPricingAggregateByConsultationId: async id => ({ medications: [{ consultation_medication_id: 1, amount: id }, { consultation_medication_id: 2, amount: 120 }] }),
  });
  const invoke = async (name, query = {}) => {
    let result;
    const res = { status(code) { this.code = code; return this; }, json(data) { result = data; } };
    await handlers[name]({ params: { appointment_id: '300' }, selectedBranchId: 2, query }, res);
    return result;
  };
  return { calls, invoke };
}

for (const count of [0, 1, 2, 3]) test(`options endpoint handles ${count} available prescriptions without mixing their contents`, async () => {
  const { invoke, calls } = controller({ count });
  const result = await invoke('getRepeatTreatmentOptions');
  assert.equal(result.data.length, count);
  assert.deepEqual(calls[0], { kind: 'appointment', id: 300, branch: 2 });
  for (const item of result.data) {
    assert.equal(item.medications.length, 2);
    assert.equal(item.medications[0].medicine_value, String(item.source_appointment_id));
    assert.equal(item.medications[0].doses[0].balls_per_dose, 5);
    assert.equal(item.medications[0].amount, item.source_consultation_id);
    assert.equal(item.medications[1].remark, 'After food');
    assert.equal(item.medications[1].amount, 120);
    assert.equal(item.medications[1].is_manual_entry, 1);
    assert.equal(item.medication_duration_days, 15);
  }
});
test('selected prescription loads that source only; the existing default endpoint still selects its linked source', async () => {
  const { invoke, calls } = controller();
  assert.equal((await invoke('getRepeatTreatmentDraft', { source_consultation_id: '18' })).data.source_appointment_id, 180);
  assert.equal((await invoke('getRepeatTreatmentDraft')).data.source_appointment_id, 190);
  assert.deepEqual(calls.filter(c => c.kind === 'aggregate').map(c => c.id), [180, 190]);
});
test('invalid, stale, foreign patient/family, current or fourth-oldest source cannot be fetched by supplying its id', async () => {
  const { invoke, calls } = controller();
  for (const id of ['0', 'abc', '17', '300', '99999']) await assert.rejects(invoke('getRepeatTreatmentDraft', { source_consultation_id: id }), e => [400, 409].includes(e.statusCode));
  assert.equal(calls.filter(c => c.kind === 'aggregate').length, 0);
});
test('both endpoints retain follow-up-only and appointment branch-scope checks', async () => {
  for (const name of ['getRepeatTreatmentOptions', 'getRepeatTreatmentDraft']) {
    await assert.rejects(controller({ visitType: 'FIRST_CONSULTATION' }).invoke(name), e => e.statusCode === 409);
    await assert.rejects(controller({ missing: true }).invoke(name), e => e.statusCode === 404);
  }
});
