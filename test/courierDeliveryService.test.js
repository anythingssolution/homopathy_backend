const test = require('node:test');
const assert = require('node:assert/strict');
const { getLastCourierDelivery } = require('../services/courierDeliveryService');

test('last courier delivery returns only reusable address details for patient and branch', async () => {
    let capturedSql = '';
    let capturedParams = [];
    const result = await getLastCourierDelivery({
        patientId: 1594,
        branchId: 2,
        queryFn: async (sql, params) => {
            capturedSql = sql;
            capturedParams = params;
            return [{
                bill_id: 42,
                delivery_details_json: JSON.stringify({
                    courier_address: '  Raipur address  ',
                    received_by: 'Patient',
                    tracking_no: 'must-not-be-reused',
                }),
                updated_at: '2026-09-25 12:00:00',
            }];
        },
    });

    assert.match(capturedSql, /b\.patient_id = \?/);
    assert.match(capturedSql, /b\.fk_branch_id = \?/);
    assert.deepEqual(capturedParams, [1594, 2]);
    assert.deepEqual(result, {
        courier_address: 'Raipur address',
        received_by: 'Patient',
        last_used_at: '2026-09-25 12:00:00',
    });
    assert.equal(result.tracking_no, undefined);
});

test('last courier delivery returns null when no saved courier bill exists', async () => {
    const result = await getLastCourierDelivery({
        patientId: 1594,
        queryFn: async () => [],
    });
    assert.equal(result, null);
});
