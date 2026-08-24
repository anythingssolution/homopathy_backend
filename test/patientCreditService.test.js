const test = require('node:test');
const assert = require('node:assert/strict');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_patient_credit_secret';
process.env.DB_HOST = process.env.DB_HOST || '127.0.0.1';
process.env.DB_USER = process.env.DB_USER || 'test_user';
process.env.DB_NAME = process.env.DB_NAME || 'test_db';

const {
    allocateReceivedAmount,
    filterOutstandingBills,
    summarizeOutstandingBills,
} = require('../services/patientCreditService');

test('current-first allocation keeps previous dues when patient underpays today', () => {
    const result = allocateReceivedAmount({
        receivedAmount: 500,
        currentPending: 700,
        previousBills: [{ bill_id: 11, pending_amount: 200 }],
        allocationOrder: 'CURRENT_FIRST',
    });

    assert.equal(result.current_applied, 500);
    assert.equal(result.current_remaining, 200);
    assert.equal(result.previous_applied, 0);
    assert.equal(result.previous_remaining, 200);
    assert.equal(result.total_remaining, 400);
    assert.deepEqual(result.previous_allocations, []);
});

test('current-first leftover after today settles oldest previous dues', () => {
    const result = allocateReceivedAmount({
        receivedAmount: 800,
        currentPending: 700,
        previousBills: [
            { bill_id: 11, pending_amount: 200 },
            { bill_id: 12, pending_amount: 150 },
        ],
        allocationOrder: 'CURRENT_FIRST',
    });

    assert.equal(result.current_applied, 700);
    assert.equal(result.current_remaining, 0);
    assert.equal(result.previous_applied, 100);
    assert.equal(result.previous_remaining, 250);
    assert.deepEqual(result.previous_allocations, [{
        bill_id: 11,
        amount: 100,
        pending_before: 200,
        pending_after: 100,
    }]);
});

test('previous-first allocation clears older dues before today', () => {
    const result = allocateReceivedAmount({
        receivedAmount: 500,
        currentPending: 700,
        previousBills: [{ bill_id: 11, pending_amount: 200 }],
        allocationOrder: 'PREVIOUS_FIRST',
    });

    assert.equal(result.current_applied, 300);
    assert.equal(result.current_remaining, 400);
    assert.equal(result.previous_applied, 200);
    assert.equal(result.previous_remaining, 0);
});

test('paying zero borrows the full current bill and leaves previous dues', () => {
    const result = allocateReceivedAmount({
        receivedAmount: 0,
        currentPending: 500,
        previousBills: [{ bill_id: 11, pending_amount: 200 }],
    });

    assert.equal(result.received, 0);
    assert.equal(result.current_applied, 0);
    assert.equal(result.current_remaining, 500);
    assert.equal(result.previous_remaining, 200);
    assert.equal(result.total_remaining, 700);
});

test('current-only leftover cannot be applied to previous dues', () => {
    assert.throws(
        () => allocateReceivedAmount({
            receivedAmount: 800,
            currentPending: 700,
            previousBills: [{ bill_id: 11, pending_amount: 200 }],
            allocationOrder: 'CURRENT_ONLY',
        }),
        (error) => error.statusCode === 400 && /today's bill/.test(error.message)
    );
});

test('current-only underpay leaves previous dues untouched', () => {
    const result = allocateReceivedAmount({
        receivedAmount: 500,
        currentPending: 700,
        previousBills: [{ bill_id: 11, pending_amount: 200 }],
        allocationOrder: 'CURRENT_ONLY',
    });

    assert.equal(result.current_applied, 500);
    assert.equal(result.current_remaining, 200);
    assert.equal(result.previous_applied, 0);
    assert.equal(result.previous_remaining, 200);
});

test('overpaying total due is rejected', () => {
    assert.throws(
        () => allocateReceivedAmount({
            receivedAmount: 1000,
            currentPending: 700,
            previousBills: [{ bill_id: 11, pending_amount: 200 }],
        }),
        (error) => error.statusCode === 400 && /greater than total due/.test(error.message)
    );
});

test('outstanding summary excludes the current consultation', () => {
    const bills = filterOutstandingBills([
        { bill_id: 1, consultation_id: 88, pending_amount: 200 },
        { bill_id: 2, consultation_id: 99, pending_amount: 150 },
    ], { excludeConsultationIds: [88] });

    assert.deepEqual(summarizeOutstandingBills(bills), {
        total_pending: 150,
        bills_count: 1,
        bills,
    });
});
