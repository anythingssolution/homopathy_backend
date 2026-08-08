const test = require('node:test');
const assert = require('node:assert/strict');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_live_queue_check_in_secret';
process.env.DB_HOST = process.env.DB_HOST || '127.0.0.1';
process.env.DB_USER = process.env.DB_USER || 'test_user';
process.env.DB_NAME = process.env.DB_NAME || 'test_db';

const dbModulePath = require.resolve('../config/db');
const executedStatements = [];
const checkedInAt = new Date('2026-08-02T10:00:00.000Z');
const currentAppointment = {
    appointment_id: 77,
    fk_branch_id: 2,
    fk_slot_id: 1,
    appointment_date: '2026-08-02',
    queue_status: 'BOOKED',
    status: 'Pending',
    is_active: 1,
    fk_patient_id: 371,
    fk_patient_family_member_id: 42,
    fk_treatment_id: 2,
    treatment_code: 'FOLLOW_UP_VISIT',
    treatment_name: 'Follow-up Visit',
    consultation_fee: '500.00',
    consultation_payment_status: 'PAID',
    consultation_payment_settlement_type: 'FOLLOW_UP',
    follow_up_free_days: 30,
};

const connection = {
    execute: async (sql, params = []) => {
        executedStatements.push({ sql, params });

        if (sql.includes('FROM tbl_appointments a') && sql.includes('FOR UPDATE')) {
            return [[currentAppointment]];
        }
        if (sql.includes('SELECT NOW() AS checked_in_at')) {
            return [[{ checked_in_at: checkedInAt }]];
        }
        if (sql.includes('SELECT appointment_date, actual_completed_at, created_at')) {
            return [[{ actual_completed_at: new Date('2026-07-02T10:00:00.000Z') }]];
        }
        if (sql.includes('UPDATE tbl_appointments') || sql.includes('UPDATE tbl_bills')) {
            return [{ affectedRows: 1 }];
        }

        throw new Error(`Unexpected SQL in check-in regression: ${sql}`);
    },
};

require.cache[dbModulePath] = {
    id: dbModulePath,
    filename: dbModulePath,
    loaded: true,
    exports: {
        query: async () => [{
            appointment_id: 77,
            fk_branch_id: 2,
            fk_slot_id: 1,
            appointment_date: '2026-08-02',
        }],
        withTransaction: async (handler) => handler(connection),
    },
};

const { checkInAppointment } = require('../controllers/v1/liveQueueController');

test('chargeable family follow-up requires payment before any queue mutation', async () => {
    const response = await new Promise((resolve, reject) => {
        const res = {
            statusCode: 200,
            status(code) {
                this.statusCode = code;
                return this;
            },
            json(body) {
                resolve({ statusCode: this.statusCode, body });
                return this;
            },
        };

        checkInAppointment({
            params: { appointment_id: '77' },
            headers: {},
            user: { id: 9 },
            ip: '127.0.0.1',
            socket: {},
        }, res, reject);
    });

    assert.deepEqual(response, {
        statusCode: 409,
        body: {
            success: false,
            code: 'CONSULTATION_PAYMENT_REQUIRED',
            message: 'Consultation payment is required before check-in',
            data: {
                appointment_id: 77,
                amount: 500,
                days_difference: 31,
                free_days: 30,
            },
        },
    });

    const historyQuery = executedStatements.find(({ sql }) => (
        sql.includes('SELECT appointment_date, actual_completed_at, created_at')
    ));
    assert.deepEqual(historyQuery.params, [371, 77, 42, checkedInAt]);
    assert.equal(executedStatements.some(({ sql }) => sql.includes('SET queue_status = ?')), false);
});
