const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
require('dotenv').config();
const { buildConsistentHistoricalManualProducts } = require('../controllers/v1/doctor/shared');

const mastersHandler = ({ medicines, products, history = [] }) => {
    const calls = [];
    const source = fs.readFileSync(path.join(__dirname, '../controllers/v1/doctor/dashboardController.js'), 'utf8');
    const start = source.indexOf('const getDoctorTextMedicineMasters =');
    const context = { module: { exports: {} },
        asyncHandler: fn => fn,
        query: async sql => { calls.push(sql); return sql.includes('FROM master_text_medicines') ? medicines
            : sql.includes('FROM tbl_consultation_medications') ? history : []; },
        buildTextMedicineProductMasters: async () => ({
            medicalProducts: new Map(medicines.map(m => [m.id, products.filter(p => p.medicine_text_id === m.id)])),
            products: new Map(), radientPharmaProducts: new Map(), handwrittenProductPrices: new Map(),
        }),
        buildConsistentHistoricalManualProducts,
        normalizeMasterValue: value => String(value || '').trim().toLowerCase(),
        UNIVERSAL_REMARK_SELECTION_VALUE: '__UNIVERSAL_REMARK__',
    };
    vm.createContext(context);
    vm.runInContext(source.slice(start, source.indexOf('module.exports', start))
        + '\nmodule.exports = getDoctorTextMedicineMasters;', context);
    return { calls, invoke: () => new Promise((resolve, reject) => {
        context.module.exports({}, { status() { return this; }, json: resolve }).catch(reject);
    }) };
};

test('manual names require an active product; deleting a variant does not recreate it from historical pricing', async () => {
    const handler = mastersHandler({
        medicines: [{ id: 7, medicine_value: 'DROP', normalized_value: 'drop', is_doctor_manual: 1 }],
        products: [{ id: 9, medicine_text_id: 7, product_name: 'DROP', source_type: 'DOCTOR_MANUAL', packing: '100 ML', mrp_rate: 100 }],
        history: [{ medicine_value: 'DROP - 100 ML', amount: 80 }, { medicine_value: 'DROP - 200 ML', amount: 160 }, { medicine_value: 'DROP', amount: 40 }],
    });
    const result = await handler.invoke();
    assert.match(handler.calls[0], /AND EXISTS/);
    assert.doesNotMatch(handler.calls[0], /is_doctor_manual\s*=\s*1\s+OR/i);
    const medicine = result.data.text_medicines[0];
    assert.equal(medicine.medical_products.length, 1);
    assert.equal(medicine.medical_products[0].packing, '100 ML');
    assert.equal(medicine.medical_products[0].mrp_rate, 100);
    assert.equal(medicine.medical_products[0].historical_unit_price, 80);
    assert.equal(medicine.default_manual_price, null, 'deleted default variant must not supply a hidden price');
});

test('an active unspecified-packing product still retains compatible historical default pricing', async () => {
    const result = await mastersHandler({
        medicines: [{ id: 8, medicine_value: 'CUSTOM', normalized_value: 'custom', is_doctor_manual: 1 }],
        products: [{ id: 10, medicine_text_id: 8, product_name: 'CUSTOM', source_type: 'DOCTOR_MANUAL', packing: 'N/A', mrp_rate: null }],
        history: [{ medicine_value: 'CUSTOM', amount: 85 }],
    }).invoke();
    assert.equal(result.data.text_medicines[0].default_manual_price, 85);
    assert.equal(result.data.text_medicines[0].medical_products.length, 0);
});

test('manual-product repair is rerunnable and preserves inactive products and existing prices in isolated tables', {
    skip: process.env.RUN_MANUAL_CATALOG_DB_TEST !== '1',
}, async () => {
    const mysql = require('mysql2/promise');
    const connection = await mysql.createConnection({ host: process.env.DB_HOST, port: process.env.DB_PORT,
        user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME, multipleStatements: true });
    try {
        // All writes below are to connection-local synthetic tables, never clinic records.
        await connection.query(`CREATE TEMPORARY TABLE qa_catalog_names (
            id BIGINT UNSIGNED PRIMARY KEY, medicine_value VARCHAR(255), normalized_value VARCHAR(255),
            is_active TINYINT, is_doctor_manual TINYINT) ENGINE=InnoDB`);
        await connection.query(`CREATE TEMPORARY TABLE qa_catalog_products (
            id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, medicine_text_id BIGINT UNSIGNED NULL,
            source_type VARCHAR(40), product_name VARCHAR(255), packing VARCHAR(100), mrp_rate DECIMAL(10,2),
            normalized_product_name VARCHAR(255), dedupe_key VARCHAR(700), is_active TINYINT,
            UNIQUE KEY uq_source_dedupe(source_type,dedupe_key)) ENGINE=InnoDB`);
        for (const name of ['qa_catalog_names', 'qa_catalog_products']) {
            const [rows] = await connection.query(`SHOW CREATE TABLE ${name}`);
            assert.match(Object.values(rows[0]).join(' '), /CREATE TEMPORARY TABLE/);
        }
        await connection.query(`INSERT INTO qa_catalog_names VALUES
            (1,'NAME ONLY','name only',1,1),(2,'DELETED','deleted',1,1),(3,'EXISTING','existing',1,1),
            (4,'NOT MANUAL','not manual',1,0),(5,'INACTIVE NAME','inactive name',0,1),
            (6,'LEGACY LINK','legacy link',1,1),(7,'OIL + 74Q','oil + 74q',1,1)`);
        await connection.query(`INSERT INTO qa_catalog_products
            (id,medicine_text_id,source_type,product_name,packing,mrp_rate,normalized_product_name,dedupe_key,is_active) VALUES
            (20,2,'DOCTOR_MANUAL','DELETED','N/A',90,'deleted','deleted|n/a|',0),
            (30,3,'REGULAR_PRODUCT','EXISTING','100 ML',200,'existing','existing|100 ml|',1),
            (60,NULL,'REGULAR_PRODUCT','LEGACY LINK','N/A',100,'legacy link','legacy link|n/a|',1)`);
        const [original] = await connection.query('SELECT * FROM qa_catalog_products ORDER BY id');
        const file = fs.readFileSync(path.join(__dirname, '../sql/2026-11-16_sync_manual_medicines_product_master.sql'), 'utf8');
        // MySQL does not permit a TEMPORARY insert target to be read twice. A
        // fresh temporary snapshot exercises the same anti-join with identical rows.
        const sql = file.replaceAll('master_text_medicines', 'qa_catalog_names')
            .replaceAll('master_medical_products', 'qa_catalog_products')
            .replaceAll('LEFT JOIN qa_catalog_products existing_product', 'LEFT JOIN qa_catalog_snapshot existing_product');
        const apply = async () => {
            await connection.query('DROP TEMPORARY TABLE IF EXISTS qa_catalog_snapshot');
            await connection.query('CREATE TEMPORARY TABLE qa_catalog_snapshot AS SELECT * FROM qa_catalog_products');
            const [results] = await connection.query(sql);
            return results.flat().find(row => row && Object.hasOwn(row, 'inserted_product_rows')).inserted_product_rows;
        };
        assert.equal(await apply(), 2);
        const [created] = await connection.query('SELECT * FROM qa_catalog_products WHERE medicine_text_id IN (1,7) ORDER BY medicine_text_id');
        assert.deepEqual(created.map(row => row.medicine_text_id), [1, 7]);
        assert.ok(created.every(row => row.packing === 'N/A' && row.mrp_rate === null));
        assert.equal(await apply(), 0);
        await connection.query('UPDATE qa_catalog_products SET is_active=0 WHERE medicine_text_id=1');
        assert.equal(await apply(), 0, 'retry must not resurrect a deleted backfilled row');
        const [preserved] = await connection.query('SELECT * FROM qa_catalog_products WHERE id IN (20,30,60) ORDER BY id');
        assert.deepEqual(preserved, original);
        const handler = mastersHandler({ medicines: [], products: [] });
        await handler.invoke();
        const query = handler.calls[0].replaceAll('master_text_medicines', 'qa_catalog_names')
            .replaceAll('master_medical_products', 'qa_catalog_products')
            .replace('created_at, updated_at', 'id AS created_at, id AS updated_at');
        const [visible] = await connection.query(query);
        assert.deepEqual(visible.map(row => row.id).sort((a,b) => a-b), [3, 6, 7]);
    } finally { await connection.end(); }
});
