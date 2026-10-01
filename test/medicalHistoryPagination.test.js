const test = require('node:test');
const assert = require('node:assert/strict');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_medical_history_secret';
process.env.DB_HOST = process.env.DB_HOST || '127.0.0.1';
process.env.DB_USER = process.env.DB_USER || 'test_user';
process.env.DB_NAME = process.env.DB_NAME || 'test_db';

const db = require('../config/db');
const capturedQueries = [];
db.query = async (sql, params) => {
    capturedQueries.push({ sql, params });
    if (sql.includes('SELECT COUNT(*) AS total FROM (')) return [{ total: 0 }];
    if (sql.includes('priced_history') && sql.includes('LIMIT 20 OFFSET 0')) return [];
    return [];
};

const { listPricedMedicalPrescriptions } = require('../controllers/v1/medicalController');

test('dispensary history paginates one combined consultation and medicine-purchase timeline', async () => {
    capturedQueries.length = 0;
    const payload = await new Promise((resolve, reject) => {
        const req = {
            query: { branch_id: '1', page: '1', page_size: '20' },
            selectedBranchId: 1,
        };
        const res = {
            statusCode: 200,
            status(code) { this.statusCode = code; return this; },
            json(body) { resolve({ statusCode: this.statusCode, body }); return this; },
        };
        listPricedMedicalPrescriptions(req, res, reject);
    });

    assert.equal(payload.statusCode, 200);
    assert.equal(payload.body.meta.total, 0);
    assert.equal(payload.body.meta.page, 1);
    assert.deepEqual(payload.body.data, []);

    const countQuery = capturedQueries.find(({ sql }) => sql.includes('SELECT COUNT(*) AS total FROM ('));
    const pageQuery = capturedQueries.find(({ sql }) => sql.includes('priced_history') && sql.includes('LIMIT 20 OFFSET 0'));
    assert.ok(countQuery);
    assert.ok(pageQuery);
    assert.match(countQuery.sql, /UNION ALL/);
    assert.match(countQuery.sql, /'CONSULTATION' AS record_type/);
    assert.match(countQuery.sql, /'MEDICINE_PURCHASE' AS record_type/);
    assert.match(pageQuery.sql, /ORDER BY event_at DESC/);
});
