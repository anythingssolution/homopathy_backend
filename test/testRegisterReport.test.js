const assert = require('node:assert/strict');
const test = require('node:test');

test('test register is branch scoped and keeps day rows in consultation token order', async (t) => {
    const sharedPath = require.resolve('../services/reports/medical/shared');
    const reportPath = require.resolve('../services/reports/medical/testRegister');
    const originalSharedCache = require.cache[sharedPath];
    const originalReportCache = require.cache[reportPath];

    let capturedSql = '';
    let capturedParams = null;

    require.cache[sharedPath] = {
        id: sharedPath,
        filename: sharedPath,
        loaded: true,
        exports: {
            buildMedicalReportScope: () => ({
                whereClause: 'WHERE a.appointment_date >= ? AND a.appointment_date <= ? AND a.fk_branch_id = ?',
                params: ['2026-09-01', '2026-09-24', 2],
            }),
            query: async (sql, params) => {
                capturedSql = sql;
                capturedParams = params;
                return [{
                    appointment_id: 44,
                    appointment_date: '2026-09-24',
                    token_number: 3,
                    current_token_number: 3,
                    slot_name: 'Morning',
                    test_name: 'CBC',
                }];
            },
        },
    };
    delete require.cache[reportPath];

    t.after(() => {
        if (originalSharedCache) require.cache[sharedPath] = originalSharedCache;
        else delete require.cache[sharedPath];
        if (originalReportCache) require.cache[reportPath] = originalReportCache;
        else delete require.cache[reportPath];
    });

    const getTestRegisterReport = require('../services/reports/medical/testRegister');
    const rows = await getTestRegisterReport({});

    assert.deepEqual(capturedParams, ['2026-09-01', '2026-09-24', 2]);
    assert.match(capturedSql, /LEFT JOIN tbl_consultation_test_findings/);
    assert.match(capturedSql, /COALESCE\(fm\.full_name, p\.full_name\) AS patient_full_name/);
    assert.match(capturedSql, /a\.appointment_date DESC,\s*a\.current_token_number ASC/);
    assert.equal(rows[0].display_token_display, 'M-3');
});
