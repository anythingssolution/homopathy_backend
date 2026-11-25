const test = require('node:test');
const assert = require('node:assert/strict');
require('dotenv').config();
const { ensureManualMedicineCatalog } = require('../services/manualMedicineCatalogService');
test('non-manual medicine never writes catalog', async () => {
    const result = await ensureManualMedicineCatalog({ execute() { throw Error('Unexpected query'); } }, { medicine_type: 'NUMERIC', is_manual_entry: true });
    assert.equal(result.action, 'NOT_MANUAL');
});
test('manual false persistence flag is repaired without overwriting existing price or restoring inactive variants', { skip: process.env.RUN_MANUAL_CATALOG_DB_TEST !== '1' }, async () => {
    const mysql = require('mysql2/promise');
    const c = await mysql.createConnection({ host: process.env.DB_HOST, port: process.env.DB_PORT, user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME });
    try {
        // Connection-local tables shadow production names; real records untouched.
        for (const name of ['master_text_medicines','master_medical_products']) {
            const [schema] = await c.query(`SHOW CREATE TABLE ${name}`);
            const ddl = schema[0]['Create Table'].replace('CREATE TABLE', 'CREATE TEMPORARY TABLE').replace(/,?\s*CONSTRAINT `[^`]+` FOREIGN KEY[^\n]+/g, '');
            await c.query(ddl);
        }
        await c.beginTransaction();
        const med = { medicine_type: 'TEXT', medicine_value: 'QA DROP - 20ml * 2', is_manual_entry: true, persist_manual_master: false, amount: 200 };
        assert.equal((await ensureManualMedicineCatalog(c, med)).action, 'CREATED_PRODUCT');
        assert.equal((await ensureManualMedicineCatalog(c, { ...med, amount: 600 })).action, 'EXISTING');
        let [rows] = await c.query('SELECT * FROM master_medical_products');
        assert.equal(rows.length, 1); assert.equal(Number(rows[0].mrp_rate), 100);
        await c.query('UPDATE master_medical_products SET is_active=0');
        assert.equal((await ensureManualMedicineCatalog(c, med)).action, 'INACTIVE_PRODUCTS');
        assert.equal((await ensureManualMedicineCatalog(c, { ...med, medicine_value: 'QA DROP - 30ml' })).action, 'INACTIVE_PRODUCTS');
        await c.query('UPDATE master_medical_products SET is_active=1,medicine_text_id=NULL');
        assert.equal((await ensureManualMedicineCatalog(c, med)).action, 'LINKED');
        assert.equal((await ensureManualMedicineCatalog(c, { ...med, medicine_value: 'QA DROP - 30ml', variant_unit_price: 250 })).action, 'CREATED_PRODUCT');
        await c.query("UPDATE master_medical_products SET is_active=0 WHERE packing='20ml'");
        assert.equal((await ensureManualMedicineCatalog(c, med)).action, 'INACTIVE_VARIANT');
        assert.equal((await ensureManualMedicineCatalog(c, { medicine_type:'TEXT',medicine_value:'QA UNPRICED',is_manual_entry:true })).action, 'CREATED_PRODUCT');
        const [[unpriced]] = await c.query("SELECT mrp_rate,packing FROM master_medical_products WHERE product_name='QA UNPRICED'");
        assert.equal(unpriced.mrp_rate, null); assert.equal(unpriced.packing, 'N/A');
        await c.query('UPDATE master_text_medicines SET is_active=0');
        assert.equal((await ensureManualMedicineCatalog(c, med)).action, 'INACTIVE_NAME');
        await c.rollback();
        [rows] = await c.query('SELECT * FROM master_medical_products'); assert.equal(rows.length, 0);
    } finally { await c.end(); }
});
