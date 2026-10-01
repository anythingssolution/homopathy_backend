const assert = require('node:assert/strict');
const test = require('node:test');

test('courier register is bill-date and branch scoped with financial breakup', async (t) => {
    const sharedPath = require.resolve('../services/reports/shared');
    const reportPath = require.resolve('../services/reports/medical/courierRegister');
    const originals = new Map([
        [sharedPath, require.cache[sharedPath]],
        [reportPath, require.cache[reportPath]],
    ]);
    let capturedSql = '';
    let capturedParams = [];

    require.cache[sharedPath] = {
        id: sharedPath,
        filename: sharedPath,
        loaded: true,
        exports: {
            buildTimestampDateRangeScope: () => ({
                whereClause: 'WHERE DATE(b.created_at) >= ? AND DATE(b.created_at) <= ? AND b.fk_branch_id = ?',
                params: ['2026-09-01', '2026-09-25', 2],
            }),
            query: async (sql, params) => {
                capturedSql = sql;
                capturedParams = params;
                return [{ bill_id: 10 }];
            },
        },
    };
    delete require.cache[reportPath];

    t.after(() => {
        originals.forEach((value, key) => {
            if (value) require.cache[key] = value;
            else delete require.cache[key];
        });
    });

    const getCourierRegisterReport = require('../services/reports/medical/courierRegister');
    const rows = await getCourierRegisterReport({});

    assert.deepEqual(capturedParams, ['2026-09-01', '2026-09-25', 2]);
    assert.match(capturedSql, /b\.delivery_mode = 'COURIER'/);
    assert.doesNotMatch(capturedSql, /tbl_courier_deliveries/);
    assert.match(capturedSql, /discount_category = 'COURIER'/);
    assert.match(capturedSql, /GREATEST\(0, COALESCE\(items\.courier_gross/);
    assert.equal(rows[0].bill_id, 10);
});
