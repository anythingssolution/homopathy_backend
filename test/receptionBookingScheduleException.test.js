const test = require('node:test');
const assert = require('node:assert/strict');
process.env.JWT_SECRET = 'reception-schedule-test';
process.env.DB_HOST = '127.0.0.1'; process.env.DB_USER = 'test'; process.env.DB_NAME = 'test';
const AppError = require('../utils/AppError');
let mode = '', inserts = [], bills = 0, weeklyChecks = 0, leaveChecks = 0, weeklyClosed = true;
const weekly = require('../services/bookingWeekdayService');
weekly.assertWeeklyBookingOpen = async () => { weeklyChecks++; if (weeklyClosed) throw new AppError('Weekly closed', 409, { code: 'BOOKING_WEEKDAY_CLOSED' }); };
const leave = require('../services/doctorLeaveService');
leave.assertBranchDoctorAvailableForBooking = async () => { leaveChecks++; throw new AppError('Doctor on leave', 409); };
const treatment = { id: 1, treatment_name: 'First Consultation', treatment_code: 'FIRST_CONSULTATION', consultation_fee: 500 };
const followups = require('../services/followupService');
followups.getTreatmentById = async () => treatment;
require('../utils/patientFamily').getFamilyBookingSchemaState = async () => ({ enabled: true });
require('../services/slotTimeOverrideService').resolveEffectiveSlotTiming = async () => ({
    effectiveStartTime: '11:00:00', effectiveEndTime: '14:00:00', defaultStartTime: '11:00:00', defaultEndTime: '14:00:00', hasOverride: false,
});
require('../services/slotTokenExtensionService').buildEffectiveSlotTokenPlate = async ({ bookedTokenNumbers = new Set() }) => [
    { token_number: 1, visit_type_code: 'FIRST_CONSULTATION', visit_type_label: 'First Consultation', is_selectable: !bookedTokenNumbers.has(1) },
    { token_number: 2, visit_type_code: 'FOLLOW_UP_VISIT', visit_type_label: 'Follow-up', is_selectable: false },
];
require('../services/billingService').createConsultationBillForAppointment = async () => { bills++; return {}; };
const queue = require('../services/liveQueueService');
for (const name of ['recalculateQueuePlan', 'logQueueEvent', 'emitLiveQueueEvent']) queue[name] = async () => {};
require('../services/whatsappAutomationService').scheduleAppointmentReminders = async () => {};
require('../utils/realtime').emitToRole = () => {};
const db = require('../config/db');
const read = (sql) => {
    if (sql.includes('FROM master_users')) return [{ id: 42, uuid: 'DTH42', full_name: 'Fixture', mobile_no: '9999999999', age: 25, gender: 'male', role: 'PAT', is_active: 1 }];
    if (sql.includes('FROM master_clinic_branches')) return mode === 'inactive-branch' ? [] : [{ id: 2 }];
    if (sql.includes('FROM master_treatments')) return [treatment];
    if (sql.includes('FROM master_slots')) return [{ id: 3, fk_branch_id: mode === 'wrong-branch' ? 1 : 2, slot_name: 'Morning', start_time: '11:00:00', end_time: '14:00:00' }];
    if (sql.includes('status IN')) return mode === 'duplicate' ? [{ appointment_id: 88 }] : [];
    if (sql.includes('SELECT token_number, current_token_number')) return mode === 'occupied' ? [{ token_number: 1, current_token_number: 1 }] : [];
    if (sql.includes('GET_LOCK')) return [{ acquired_lock: 1 }];
    if (sql.includes('SELECT auid') || sql.includes('DO RELEASE_LOCK') || sql.includes('FROM tbl_appointments a')) return [];
    throw new Error(`Unexpected SQL in fixture: ${sql}`);
};
db.query = async sql => read(sql);
db.withTransaction = async handler => handler({ execute: async (sql, params) => {
    if (sql.includes('INSERT INTO tbl_appointments')) { inserts.push({ sql, params }); return [{ insertId: 99 }]; }
    assert.doesNotMatch(sql, /^\s*(INSERT|UPDATE|DELETE)\b/);
    return [read(sql)];
} });
const patient = require('../controllers/v1/appointmentController');
const reception = require('../controllers/v1/receptionistController');
const invoke = (handler, request) => new Promise((resolve, reject) => handler(request, { status(code) { this.code = code; return this; }, json(body) { resolve({ code: this.code, ...body }); } }, reject));
const body = { fk_patient_id: 42, fk_branch_id: 2, fk_slot_id: 3, fk_treatment_id: 1, appointment_date: '2099-01-01', token_number: 1 };
const req = extra => ({ body: { ...body }, query: {}, user: { id: 9, role: 'receptionist', role_code: 'REC' }, headers: {}, ip: '127.0.0.1', ...extra });
function reset(value = '') { mode = value; inserts = []; bills = 0; weeklyChecks = 0; leaveChecks = 0; weeklyClosed = true; }

test('reception can load and book a matching token despite weekly closure/leave; normal bill path remains', async () => {
    reset();
    const plate = await invoke(patient.getReceptionistBookingTokenPlate, req({ query: { branch_id: 2, slot_id: 3, treatment_id: 1, appointment_date: body.appointment_date } }));
    assert.equal(plate.code, 200);
    assert.equal(plate.data.tokens[0].is_selectable, true);
    const booking = await invoke(reception.createAppointmentByReceptionist, req());
    assert.equal(booking.code, 201);
    assert.equal(inserts.length, 1); assert.equal(bills, 1);
    assert.match(inserts[0].sql, /'RECEPTIONIST'/);
    assert.equal(weeklyChecks, 0); assert.equal(leaveChecks, 0);
});

test('patient cannot enable the reception exception through request flags or role labels on patient handlers', async () => {
    reset();
    await assert.rejects(invoke(patient.getBookingTokenPlate, req({ query: { branch_id: 2, slot_id: 3, treatment_id: 1, appointment_date: body.appointment_date, allowScheduleException: true } })), e => e.details?.code === 'BOOKING_WEEKDAY_CLOSED');
    await assert.rejects(invoke(patient.createAppointment, req({ body: { ...body, allowScheduleException: true } })), e => e.details?.code === 'BOOKING_WEEKDAY_CLOSED');
    assert.equal(inserts.length, 0); assert.equal(weeklyChecks, 2);
});

test('patient booking is still rejected for doctor leave even when the weekday is open', async () => {
    reset(); weeklyClosed = false;
    await assert.rejects(invoke(patient.createAppointment, req()), /Doctor on leave/);
    assert.equal(weeklyChecks, 1); assert.equal(leaveChecks, 1); assert.equal(inserts.length, 0);
});

for (const [scenario, pattern] of [
    ['occupied', /already booked/], ['duplicate', /unresolved active appointment/],
    ['wrong-branch', /does not belong/], ['inactive-branch', /branch not found or inactive/],
]) test(`reception schedule exception preserves ${scenario} protection`, async () => {
    reset(scenario);
    await assert.rejects(invoke(reception.createAppointmentByReceptionist, req()), e => pattern.test(e.message));
    assert.equal(inserts.length, 0); assert.equal(bills, 0);
});

test('reception cannot use a token reserved for a different treatment', async () => {
    reset();
    await assert.rejects(invoke(reception.createAppointmentByReceptionist, req({ body: { ...body, token_number: 2 } })), /reserved for Follow-up/);
    assert.equal(inserts.length, 0);
});
