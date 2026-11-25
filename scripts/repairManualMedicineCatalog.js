// Explicit local/operator repair; dry-run by default. No schema changes.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { pool } = require('../config/db');
const { ensureManualMedicineCatalog } = require('../services/manualMedicineCatalogService');
const { parseTextMedicineDisplayParts } = require('../controllers/v1/doctor/shared');
const { normalizeProductVariantValue } = require('../utils/medicalProductDedupe');
const commit = process.argv.includes('--commit');
(async () => {
    const dir = path.resolve(__dirname, '../../master_prev_user_data/manual_catalog_repair_2026-11-25');
    fs.mkdirSync(dir, { recursive: true });
    const c = await pool.getConnection();
    try {
        if (commit) {
            if (!['127.0.0.1','localhost'].includes(process.env.DB_HOST)) throw Error('Commit requires explicitly reviewed local database');
            const backup = path.join(dir, `database-before-${Date.now()}.sql`);
            const fd = fs.openSync(backup, 'wx', 0o600);
            const dump = spawnSync('/opt/homebrew/opt/mariadb/bin/mariadb-dump', ['--host='+process.env.DB_HOST,'--port='+(process.env.DB_PORT||3306),'--user='+process.env.DB_USER,'--single-transaction',process.env.DB_NAME], { env: {...process.env,MYSQL_PWD:process.env.DB_PASSWORD}, stdio:['ignore',fd,'pipe'] });
            fs.closeSync(fd); if (dump.status !== 0) throw Error(String(dump.stderr));
        }
        const [history] = await c.query(`SELECT cm.id,cm.medicine_value, pi.amount FROM tbl_consultation_medications cm
            JOIN tbl_consultations co ON co.id=cm.consultation_id JOIN tbl_appointments a ON a.appointment_id=co.appointment_id
            LEFT JOIN tbl_medical_prescription_pricing pp ON pp.consultation_id=co.id
            LEFT JOIN tbl_medical_prescription_pricing_items pi ON pi.pricing_id=pp.id AND pi.consultation_medication_id=cm.id AND COALESCE(pi.dispense_status,'ACTIVE')<>'VOID'
            WHERE cm.medicine_type='TEXT' AND cm.is_manual_entry=1 AND COALESCE(cm.added_by_role,'DOCTOR')<>'MEDICAL' AND a.is_active=1 AND a.status='Completed' ORDER BY cm.id`);
        const candidates = new Map();
        for (const row of history) {
            const parsed = parseTextMedicineDisplayParts(row.medicine_value);
            const key = parsed.medicine_value.trim().toLowerCase()+'|'+normalizeProductVariantValue(parsed.variant_value || 'N/A');
            if (!candidates.has(key)) candidates.set(key, { medicine_type:'TEXT', medicine_value:row.medicine_value, master_medicine_value:parsed.medicine_value, variant_value:parsed.variant_value||'N/A', is_manual_entry:true, prices:new Set() });
            const price = Number(row.amount)/parsed.quantity;
            if (Number.isFinite(price) && price>0) candidates.get(key).prices.add(price.toFixed(2));
        }
        await c.beginTransaction();
        const [namesBefore] = await c.query('SELECT * FROM master_text_medicines ORDER BY id');
        const [productsBefore] = await c.query('SELECT * FROM master_medical_products ORDER BY id');
        const actions=[];
        for (const candidate of candidates.values()) {
            const prices=[...candidate.prices];
            const result=await ensureManualMedicineCatalog(c,{...candidate,variant_unit_price:prices.length===1?Number(prices[0]):null});
            actions.push({name:candidate.master_medicine_value,variant:candidate.variant_value,price:prices.length===1?prices[0]:null,conflictingPrices:prices.length>1,...result});
        }
        const [namesAfter] = await c.query('SELECT * FROM master_text_medicines ORDER BY id');
        const [productsAfter] = await c.query('SELECT * FROM master_medical_products ORDER BY id');
        for(const before of namesBefore) if(JSON.stringify(before)!==JSON.stringify(namesAfter.find(x=>x.id===before.id))) throw Error('Existing medicine changed '+before.id);
        for(const before of productsBefore) {
            const actual={...productsAfter.find(x=>x.id===before.id)},expected={...before};
            if(before.medicine_text_id==null && actions.some(a=>a.action==='LINKED'&&a.medicineId===actual.medicine_text_id)) {delete actual.medicine_text_id;delete expected.medicine_text_id;delete actual.updated_at;delete expected.updated_at;}
            if(JSON.stringify(actual)!==JSON.stringify(expected))throw Error('Existing product changed '+before.id);
        }
        const report={commit,addedNames:namesAfter.length-namesBefore.length,addedProducts:productsAfter.length-productsBefore.length,actions};
        fs.writeFileSync(path.join(dir,commit?'committed.json':'preview.json'),JSON.stringify(report,null,2),{mode:0o600});
        if(commit)await c.commit();else await c.rollback();
        console.log(JSON.stringify({commit,addedNames:report.addedNames,addedProducts:report.addedProducts,counts:actions.reduce((a,r)=>(a[r.action]=(a[r.action]||0)+1,a),{})}));
    } catch(e){await c.rollback();throw e;}finally{c.release();await pool.end();}
})().catch(e=>{console.error(e);process.exitCode=1;});
