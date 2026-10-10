const test = require('node:test');
const assert = require('node:assert/strict');
process.env.JWT_SECRET = 'registration-test';
process.env.DB_HOST = '127.0.0.1';
process.env.DB_USER = 'test';
process.env.DB_NAME = 'test';
const { normalizePatientRegistrationId, assertRegistrationIdAvailable } = require('../utils/patientRegistrationId');
const db = require('../config/db');
let calls = [];
let existing = null;
let conflictingId = false;
db.withTransaction = async handler => handler({ execute: async (sql, params = []) => {
    calls.push({ sql, params });
    assert.equal((sql.match(/\?/g) || []).length, params.length, 'SQL parameter count must match');
    if (sql.includes('WHERE mobile_no = ?') && !sql.includes('id <>')) return [existing ? [existing] : []];
    if (sql.includes('WHERE uuid = ?')) return [conflictingId ? [{ id: 99 }] : []];
    if (sql.includes('SELECT id, uuid') && sql.includes('WHERE id = ?')) return [[existing]];
    if (sql.includes('SELECT id, role') && sql.includes('id <>')) return [[]];
    if (sql.includes('INSERT INTO master_users')) return [{ insertId: 50, affectedRows: 1 }];
    if (sql.includes('SELECT') && sql.includes('u.id AS patient_id')) return [[{patient_id: existing?.id || 50, patient_uuid:'DTH_115', import_action: existing ? 'LINK_EXISTING' : 'CREATE_PATIENT'}]];
    return [{ affectedRows: 1 }];
} });
db.query = async (sql, params = []) => {
    calls.push({sql, params});
    assert.equal((sql.match(/\?/g) || []).length,params.length);
    return sql.includes('COUNT(*)') ? [{total:8674}] : [];
};
const controller = require('../controllers/v1/patientRegistrationController');
const invoke = (fn, req) => new Promise((resolve,reject)=>fn(req,{status(){return this;},json:resolve},reject));
const req = () => ({body:{patient_uuid:'115', full_name:'Patient Name', age:25, gender:'female', mobile_no:'9999999999'},user:{id:2,role:'REC'},headers:{},params:{patient_id:'7'}});

test('registration normalizes numeric and DTH IDs without allowing blank or arbitrary strings', () => {
    assert.equal(normalizePatientRegistrationId(' dth 115 '),'DTH_115');
    assert.equal(normalizePatientRegistrationId(115),'DTH_115');
    assert.equal(normalizePatientRegistrationId(' dth_9990 '),'DTH_9990');
    for(const value of ['',null,'0','DTH0','DTH-115','DTH01','ABC115','DTH'+'1'.repeat(34)]) assert.throws(()=>normalizePatientRegistrationId(value));
});
test('duplicate registration number is rejected before modifying patient records', async () => {
    await assert.rejects(assertRegistrationIdAvailable({execute:async()=>[[{id:99}]]},'DTH_115',7),e=>e.statusCode===409);
    calls=[]; existing={id:7,uuid:'DTH7',role:'PAT',is_active:1}; conflictingId=true;
    await assert.rejects(invoke(controller.createRegisteredPatient,req()),e=>e.statusCode===409);
    assert(!calls.some(c=>/^\s*(UPDATE|INSERT)/.test(c.sql)));
    conflictingId=false;
});
test('new patient saves entered registration as UUID with matching insert parameters', async () => {
    calls=[];existing=null;
    const response=await invoke(controller.createRegisteredPatient,req());
    const insert=calls.find(c=>c.sql.includes('INSERT INTO master_users'));
    assert.equal(insert.params[0],'DTH_115');
    assert.equal(response.data.patient_uuid,'DTH_115');
});
test('matching contact keeps internal ID and audits the registration correction', async () => {
    calls=[];existing={id:7,uuid:'DTH700',role:'PAT',is_active:1};
    await invoke(controller.createRegisteredPatient,req());
    assert(!calls.some(c=>c.sql.includes('INSERT INTO master_users')));
    const update=calls.find(c=>c.sql.includes('UPDATE master_users'));
    assert.equal(update.params[0],'DTH_115');assert.equal(update.params.at(-1),7);
    const audit=calls.find(c=>c.sql.includes('INSERT INTO log_user_profile_updates'));
    assert.deepEqual(JSON.parse(audit.params[5]),{uuid:'DTH700'});
    assert.deepEqual(JSON.parse(audit.params[6]),{uuid:'DTH_115'});
});
test('registration edit updates UUID rather than assigning another patient account', async () => {
    calls=[];existing={id:7,uuid:'DTH700',role:'PAT',is_active:1};
    await invoke(controller.updateRegisteredPatient,req());
    const update=calls.find(c=>c.sql.includes('UPDATE master_users'));
    assert.match(update.sql,/SET uuid = \?/);assert.equal(update.params[0],'DTH_115');assert.equal(update.params.at(-1),7);
    assert(calls.some(c=>c.sql.includes('INSERT INTO log_user_profile_updates')));
});
test('registration list includes all active patients regardless of visits', async () => {
    calls=[];
    const result=await invoke(controller.listRegisteredPatients,{query:{search:'DTH_115'}});
    assert.equal(result.meta.total,8674);
    for(const c of calls){assert.match(c.sql,/u.is_active = 1/);assert.doesNotMatch(c.sql,/IS NOT NULL|tbl_appointments/);}
});
