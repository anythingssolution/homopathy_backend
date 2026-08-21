const assert = require('node:assert/strict');
const test = require('node:test');

test('consultant revenue report separates test/lab and courier revenue without duplicating bills by payments', async (t) => {
    const sharedPath = require.resolve('../services/reports/billing/shared');
    const reportPath = require.resolve('../services/reports/billing/revenueByConsultant');
    const originalSharedCache = require.cache[sharedPath];
    const originalReportCache = require.cache[reportPath];

    let capturedSql = '';
    let capturedParams = null;

    require.cache[sharedPath] = {
        id: sharedPath,
        filename: sharedPath,
        loaded: true,
        exports: {
            buildBillingReportScope: () => ({
                whereClause: 'WHERE 1 = 1',
                params: ['2026-08-22'],
            }),
            query: async (sql, params) => {
                capturedSql = sql;
                capturedParams = params;
                return [
                    { doctor_id: 1, session_type: 'morning', test_lab_revenue: 150, courier_medicine_revenue: 500, courier_charge_revenue: 50, courier_revenue: 550 },
                    { doctor_id: 2, session_type: 'evening', test_lab_revenue: 75, courier_medicine_revenue: 250, courier_charge_revenue: 25, courier_revenue: 275 },
                ];
            },
        },
    };
    delete require.cache[reportPath];

    t.after(() => {
        if (originalSharedCache) {
            require.cache[sharedPath] = originalSharedCache;
        } else {
            delete require.cache[sharedPath];
        }
        if (originalReportCache) {
            require.cache[reportPath] = originalReportCache;
        } else {
            delete require.cache[reportPath];
        }
    });

    const getRevenueByConsultantReport = require('../services/reports/billing/revenueByConsultant');
    const report = await getRevenueByConsultantReport({});

    assert.equal(report.morning[0].test_lab_revenue, 150);
    assert.equal(report.morning[0].courier_medicine_revenue, 500);
    assert.equal(report.morning[0].courier_charge_revenue, 50);
    assert.equal(report.morning[0].courier_revenue, 550);
    assert.equal(report.evening[0].test_lab_revenue, 75);
    assert.deepEqual(capturedParams, ['2026-08-22']);
    assert.match(capturedSql, /AS test_lab_revenue/);
    assert.match(capturedSql, /AS courier_medicine_revenue/);
    assert.match(capturedSql, /AS courier_charge_revenue/);
    assert.match(capturedSql, /AS courier_revenue/);
    assert.match(capturedSql, /FROM tbl_bill_items/);
    assert.match(capturedSql, /UPPER\(item_type\) = 'TEST'/);
    assert.match(capturedSql, /LOWER\(COALESCE\(item_name, ''\)\) = 'courier charge'/);
    assert.match(capturedSql, /LOWER\(COALESCE\(item_name, ''\)\) <> 'courier charge'/);
    assert.match(capturedSql, /COALESCE\(b\.delivery_mode, 'HAND_DELIVERY'\) = 'COURIER'/);
    assert.match(capturedSql, /COALESCE\(b\.delivery_mode, 'HAND_DELIVERY'\) <> 'COURIER'/);
    assert.match(capturedSql, /session_a\.appointment_id = COALESCE\(b\.appointment_id, c\.appointment_id\)/);
    assert.match(capturedSql, /AND c\.doctor_id IS NOT NULL/);
    assert.match(capturedSql, /COUNT\(DISTINCT UPPER\(payment_mode\)\) > 1 THEN 'MIXED'/);
    assert.doesNotMatch(capturedSql, /LEFT JOIN tbl_bill_payments bp ON bp\.bill_id = b\.id AND bp\.status = 'SUCCESS'/);
});
