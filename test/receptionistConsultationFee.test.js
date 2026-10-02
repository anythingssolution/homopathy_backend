const test = require('node:test');
const assert = require('node:assert/strict');
process.env.JWT_SECRET = 'reception-fee-test';
process.env.DB_HOST = '127.0.0.1';
process.env.DB_USER = 'test';
process.env.DB_NAME = 'test';

const db = require('../config/db');
const billing = require('../services/billingService');
require('../services/liveQueueService').emitLiveQueueEvent = async () => {};
require('../utils/realtime').emitToRole = () => {};
let state;
const reset = (fee = 0, followUp = false) => {
    state = {
        appointment: { appointment_id: 44, is_active: 1, status: 'Pending',
            reception_status: 'PENDING_AT_RECEPTION', consultation_bill_id: 7,
            consultation_payment_status: followUp ? 'PAID' : 'UNPAID',
            consultation_payment_settlement_type: followUp ? 'FOLLOW_UP' : 'COLLECTED',
            fk_branch_id: 1, fk_slot_id: 2, current_token_number: 44,
            appointment_date: '2026-10-02', queue_status: 'BOOKED' },
        bill: { id: 7, bill_type: 'CONSULTATION', status: 'ACTIVE', appointment_id: 44,
            patient_id: 10, gross_amount: fee, total_amount: fee, paid_amount: 0,
            pending_amount: fee, payment_status: followUp ? 'PAID' : 'UNPAID' },
        payments: [], discounts: [],
    };
};
db.query = async () => [state.appointment];
billing.getBillDetailById = async () => state.bill;
db.withTransaction = async (fn) => {
    const before = structuredClone(state);
    try {
        return await fn({ execute: async (rawSql, params) => {
            const sql = rawSql.replace(/\s+/g, ' ').trim();
            if (sql.startsWith('SELECT appointment_id')) return [[{ ...state.appointment }]];
            if (sql.startsWith('SELECT pending_amount')) return [[{ pending_amount: state.bill.pending_amount }]];
            if (sql.startsWith('SELECT') && sql.includes('FROM tbl_bills')) {
                return [[{ ...state.bill, consultation_payment_status: state.appointment.consultation_payment_status }]];
            }
            if (sql.startsWith('UPDATE tbl_bills SET gross_amount') && sql.includes('discount_amount')) {
                [state.bill.gross_amount, state.bill.discount_amount, state.bill.total_amount,
                    state.bill.pending_amount, state.bill.payment_status] = params;
            } else if (sql.startsWith('UPDATE tbl_bills SET gross_amount')) {
                state.bill.gross_amount = params[0];
            } else if (sql.startsWith('UPDATE tbl_bills SET total_amount')) {
                [state.bill.total_amount, state.bill.paid_amount, state.bill.pending_amount,
                    state.bill.payment_status] = params;
            } else if (sql.startsWith('UPDATE tbl_appointments SET consultation_payment_status')) {
                state.appointment.consultation_payment_status = params[0];
            } else if (sql.startsWith('UPDATE tbl_appointments SET reception_status')) {
                state.appointment.reception_status = 'APPROVED_BY_RECEPTION';
            } else if (sql.startsWith('UPDATE tbl_bill_discounts')) {
                state.discounts = [];
            } else if (sql.startsWith('INSERT INTO tbl_bill_discounts')) {
                state.discounts.push({ amount: params[3], reason: params[4] });
            } else if (sql.startsWith('INSERT INTO tbl_bill_payments')) {
                state.payments.push({ billId: params[0], amount: params[7], mode: params[10],
                    reference: params[11], remark: params[12], collector: params[13] });
            } else {
                throw new Error(`Unhandled test SQL: ${sql}`);
            }
            return [{ affectedRows: 1 }];
        } });
    } catch (error) {
        state = before;
        throw error;
    }
};
const { approveReceptionistAppointment } = require('../controllers/v1/receptionistController');
const approve = (body) => new Promise((resolve, reject) => approveReceptionistAppointment({
    params: { appointment_id: '44' }, body, user: { id: 3, role_code: 'REC' },
}, { status() { return this; }, json: resolve }, reject));
const cash = (amount) => ({ consultation_fee: amount, amount, payment_mode: 'CASH', discounts: [], remark: 'Consultation' });

test('receptionist collects 500 from a zero-fee bill and stores receipt, totals and approval', async () => {
    reset();
    await approve(cash(500));
    assert.equal(state.bill.gross_amount, 500);
    assert.equal(state.bill.total_amount, 500);
    assert.equal(state.bill.paid_amount, 500);
    assert.equal(state.bill.pending_amount, 0);
    assert.equal(state.appointment.consultation_payment_status, 'PAID');
    assert.equal(state.appointment.reception_status, 'APPROVED_BY_RECEPTION');
    assert.deepEqual(state.payments, [{ billId: 7, amount: 500, mode: 'CASH', reference: null, remark: 'Consultation', collector: 3 }]);
});

test('receptionist can collect a different fee from the original configured amount', async () => {
    reset(500);
    await approve(cash(750));
    assert.equal(state.bill.gross_amount, 750);
    assert.equal(state.bill.paid_amount, 750);
});

test('custom consultation fee retains reasoned discounts and collects only net payable', async () => {
    reset();
    await approve({ ...cash(500), amount: 400,
        discounts: [{ category: 'CONSULTATION', amount: 100, reason_code: 'DOCTOR_APPROVED' }] });
    assert.equal(state.bill.gross_amount, 500);
    assert.equal(state.bill.total_amount, 400);
    assert.equal(state.bill.paid_amount, 400);
    assert.equal(state.payments[0].amount, 400);
    assert.deepEqual(state.discounts, [{ amount: 100, reason: 'DOCTOR_APPROVED' }]);
});

test('online collection requires reference and invalid requests roll back bill and approval', async () => {
    reset();
    await assert.rejects(approve({ ...cash(500), payment_mode: 'ONLINE' }), /transaction_reference is required/);
    assert.equal(state.bill.gross_amount, 0);
    assert.equal(state.appointment.reception_status, 'PENDING_AT_RECEPTION');
    await approve({ ...cash(500), payment_mode: 'ONLINE', transaction_reference: 'UPI-TEST' });
    assert.equal(state.payments[0].reference, 'UPI-TEST');
    assert.equal(state.payments[0].mode, 'ONLINE');
});

test('explicit zero charge approves without inventing a payment receipt', async () => {
    reset(500);
    const result = await approve(cash(0));
    assert.equal(state.bill.total_amount, 0);
    assert.equal(state.bill.payment_status, 'PAID');
    assert.equal(state.payments.length, 0);
    assert.match(result.message, /without consultation charge/);
});

test('reject invalid custom fees and mismatched receipt amounts including zero payable', async () => {
    for (const fee of [-1, '', null, false, 'abc', 100000000]) {
        reset();
        await assert.rejects(approve(cash(fee)), /consultation_fee/);
        assert.equal(state.appointment.reception_status, 'PENDING_AT_RECEPTION');
    }
    reset();
    await assert.rejects(approve({ ...cash(0), amount: 500 }), /Full consultation payable/);
    reset();
    await assert.rejects(approve({ ...cash(500), amount: 400 }), /Full consultation payable/);
    assert.equal(state.bill.gross_amount, 0);
});

test('a consultation fee cannot rewrite money already collected', async () => {
    reset(500);
    state.bill.paid_amount = 100;
    state.bill.pending_amount = 400;
    state.bill.payment_status = 'PARTIAL';
    await assert.rejects(approve(cash(750)), /cannot be changed after payment/);
    assert.equal(state.bill.gross_amount, 500);
    assert.equal(state.bill.paid_amount, 100);
});

test('existing free follow-up approval still bypasses fee collection', async () => {
    reset(0, true);
    await approve({});
    assert.equal(state.appointment.reception_status, 'APPROVED_BY_RECEPTION');
    assert.equal(state.payments.length, 0);
});
