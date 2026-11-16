const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const AppError = require('../utils/AppError');

function load(relative, dependencies) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', relative), 'utf8'), {
    module, require: name => {
      if (!(name in dependencies)) throw new Error(`Unexpected dependency ${name}`);
      return dependencies[name];
    },
  });
  return module.exports;
}
const service = () => load('services/consultationPrefillService.js', {
  '../config/db': { query: () => { throw new Error('Unexpected database access'); } }, '../utils/AppError': AppError,
});
test('doctor preference is private, persistent, strictly boolean and OFF by default', async () => {
  const { getConsultationPreferences, saveConsultationPreferences } = service();
  let stored = 0;
  const execute = async (sql, params) => {
    if (sql.startsWith('UPDATE')) { assert.deepEqual(Array.from(params), [1, 91]); stored = params[0]; return {}; }
    assert.deepEqual(Array.from(params), [91]); return [{ consultation_autofill_enabled: stored }];
  };
  assert.equal((await getConsultationPreferences(91, execute)).autofill_last_visit, false);
  assert.equal((await saveConsultationPreferences(91, true, execute)).autofill_last_visit, true);
  for (const value of ['true', 1, null, undefined]) await assert.rejects(saveConsultationPreferences(91, value, execute), { statusCode: 400 });
});
test('missing migration leaves existing consult usable and reports setup pending on update', async () => {
  const execute = async () => { throw Object.assign(new Error('missing column'), { code: 'ER_BAD_FIELD_ERROR' }); };
  const prefs = await service().getConsultationPreferences(1, execute);
  assert.equal(prefs.available, false);
  assert.equal(prefs.autofill_last_visit, false);
  await assert.rejects(service().saveConsultationPreferences(1, true, execute), { statusCode: 503 });
});
test('history lookup crosses branches/doctors/types but matches exact patient/family and excludes current/future visits', async () => {
  for (const member of [723, null]) {
    const result = await service().findLastCompletedVisit({ fk_patient_id: 12, fk_patient_family_member_id: member,
      appointment_id: 200, appointment_date: '2026-11-16', actual_started_at: '2026-11-16 12:00:00' }, async (sql, params) => {
      assert.deepEqual(Array.from(params), [12, member, 200, '2026-11-16', '2026-11-16 12:00:00']);
      assert.match(sql, /fk_patient_family_member_id <=> \?/);
      assert.match(sql, /a.status = 'Completed'/);
      assert.match(sql, /ORDER BY a.appointment_date DESC, consulted_at DESC, c.id DESC LIMIT 1/);
      const where = sql.split('WHERE')[1];
      assert.doesNotMatch(where, /fk_branch_id|doctor_id|treatment|medicine_type|parent_appointment_id/);
      return [{ consultation_id: 3, branch_name: 'Other branch' }];
    });
    assert.equal(result.consultation_id, 3);
  }
});
function controller(overrides = {}) {
  return load('controllers/v1/doctor/consultationPrefillController.js', {
    './shared': { asyncHandler: fn => fn, AppError, toPositiveInt: value => Number(value) > 0 ? Number(value) : null,
      getDoctorAppointmentById: async () => ({ appointment_id: 200, is_active: 1, status: 'Confirmed' }),
      getConsultationAggregateByAppointmentId: async () => ({ consultation_id: 5, medications: [], workflow_status: 'COMPLETED_NO_PRESCRIPTION' }),
      getMedicalPricingAggregateByConsultationId: async () => null, ...overrides.shared },
    '../../../services/consultationPrefillService': { getConsultationPreferences: async () => ({ autofill_last_visit: true }),
      saveConsultationPreferences: async (id, flag) => ({ id, flag }),
      findLastCompletedVisit: async () => ({ consultation_id: 5, appointment_id: 100, branch_name: 'Other branch' }), ...overrides.service },
  });
}
const req = { user: { id: 91 }, params: { appointment_id: '200' }, selectedBranchId: 2 };
const res = { json: value => value };
test('OFF never reads history; ON supports a previous no-prescription visit without Repeat type restriction', async () => {
  const off = controller({ service: { getConsultationPreferences: async () => ({ autofill_last_visit: false }), findLastCompletedVisit: () => { throw new Error('Must not run'); } } });
  assert.equal((await off.getLastVisitPrefill(req, res)).data.enabled, false);
  const on = await controller().getLastVisitPrefill(req, res);
  assert.equal(on.data.source.appointment_id, 100);
  assert.equal(on.data.consultation.workflow_status, 'COMPLETED_NO_PRESCRIPTION');
});
test('current appointment scope stays enforced while historical aggregate has no branch argument', async () => {
  const result = await controller({ shared: {
    getDoctorAppointmentById: async (...args) => { assert.deepEqual(args, [200, 2]); return { is_active: 1, status: 'Confirmed' }; },
    getConsultationAggregateByAppointmentId: async (...args) => { assert.deepEqual(args, [100]); return { consultation_id: 5 }; },
  } }).getLastVisitPrefill(req, res);
  assert.equal(result.success, true);
  await assert.rejects(controller({ shared: { getDoctorAppointmentById: async () => null } }).getLastVisitPrefill(req, res), { statusCode: 404 });
});
test('completed, cancelled, inactive and first-ever consultations do not receive history', async () => {
  for (const booking of [{ status: 'Completed', is_active: 1 }, { status: 'Cancelled', is_active: 1 }, { status: 'Confirmed', is_active: 0 }]) {
    const result = await controller({ shared: { getDoctorAppointmentById: async () => booking },
      service: { findLastCompletedVisit: () => { throw new Error('Must not run'); } } }).getLastVisitPrefill(req, res);
    assert.equal(result.data.source, null);
  }
  assert.equal((await controller({ service: { findLastCompletedVisit: async () => null } }).getLastVisitPrefill(req, res)).data.source, null);
});
test('routes require authenticated doctor, and prefill retains appointment branch authorization', () => {
  const layers = [];
  const router = { use: (...handlers) => layers.push({ handlers }) };
  for (const method of ['get', 'put', 'post', 'patch', 'delete']) router[method] = (route, ...handlers) => layers.push({ method, route, handlers });
  load('routes/v1/doctorRoutes.js', new Proxy({ express: { Router: () => router } }, { has: () => true, get: (target, name) => target[name] ||
    (name.includes('authMiddleware') ? { authenticate: 'auth', authorizeRoles: () => 'doctor', enforceSelectedBranchScope: 'branch', authorizeAppointmentBranchScope: 'appointment' }
      : new Proxy({}, { get: (_, key) => key })) }));
  const before = [];
  for (const layer of layers) {
    if (!layer.method) before.push(...layer.handlers);
    else if (layer.route === '/consultation-preferences') {
      assert.deepEqual(before.slice(0, 2), ['auth', 'doctor']); assert.ok(!before.includes('branch'));
    } else if (layer.route.endsWith('/last-visit-prefill')) {
      assert.deepEqual(before.slice(0, 3), ['auth', 'doctor', 'branch']); assert.ok(layer.handlers.includes('appointment'));
    }
  }
});
