const test = require('node:test');
const assert = require('node:assert/strict');
const { saveAdditionalMedications } = require('../services/additionalMedicationSaveService');
function fixture(ids = [7848, 7849], referenced = ids) {
    const calls = [];
    const connection = { execute: async (sql, params) => {
        calls.push({sql, params});
        if (sql.startsWith('SELECT id FROM tbl_consultation_medications')) return [ids.map(id => ({id}))];
        if (sql.startsWith('SELECT id FROM tbl_bill_items')) return [referenced.includes(params[0]) ? [{id: 1}] : []];
        if (sql.startsWith('SELECT id FROM tbl_medical_prescription_pricing_items')) return [ids.includes(params[1]) ? [{id: params[1] + 100}] : []];
        if (sql.includes('INSERT INTO tbl_consultation_medications')) return [{insertId: 9000}];
        return [{affectedRows: 1}];
    }};
    return {connection, calls};
}
const items = [
    {consultation_medication_id:7848,medicine_value:'Ad glow aid cream',amount:190},
    {consultation_medication_id:7849,medicine_value:'Face liquid',amount:200},
];
test('billed additional medicine edit preserves both medicine and pricing IDs', async () => {
    const f = fixture();
    await saveAdditionalMedications({...f,consultationId:4444,pricingId:42,items});
    assert.equal(f.calls.some(c => /DELETE|INSERT/.test(c.sql)),false);
    assert.deepEqual(f.calls.filter(c=>c.sql.startsWith('UPDATE tbl_consultation_medications')).map(c=>c.params[1]),[7848,7849]);
    assert.deepEqual(f.calls.filter(c=>c.sql.startsWith('UPDATE tbl_medical_prescription_pricing_items')).map(c=>c.params),[['Ad glow aid cream',190,7948,42],['Face liquid',200,7949,42]]);
});
test('rejects foreign or duplicate IDs before writing', async () => {
    for (const invalid of [[{...items[0],consultation_medication_id:999}], [items[0],items[0]]]) {
        const f=fixture();
        await assert.rejects(saveAdditionalMedications({...f,consultationId:4444,pricingId:42,items:invalid}),/belong|Duplicate/);
        assert.equal(f.calls.some(c=>/^(UPDATE|DELETE|INSERT)/.test(c.sql)),false);
    }
});
test('billed removal gives a clear conflict before any delete', async () => {
    const f=fixture();
    await assert.rejects(saveAdditionalMedications({...f,consultationId:4444,pricingId:42,items:[items[0]]}),/cannot be removed/);
    assert.equal(f.calls.some(c=>c.sql.startsWith('DELETE')),false);
});
test('new medicines insert; unbilled removed medicines can be deleted',async()=>{
    const f=fixture([7848],[]);
    await saveAdditionalMedications({...f,consultationId:4444,pricingId:42,items:[{medicine_value:'New medicine',amount:50}]});
    assert.equal(f.calls.filter(c=>c.sql.startsWith('DELETE')).length,2);
    assert.ok(f.calls.some(c=>c.sql.includes('INSERT INTO tbl_medical_prescription_pricing_items')&&c.params[1]===9000));
});
