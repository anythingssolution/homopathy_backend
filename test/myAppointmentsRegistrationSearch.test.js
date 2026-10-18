const test = require('node:test');
const assert = require('node:assert/strict');
process.env.JWT_SECRET='registration-search-test';process.env.DB_HOST='127.0.0.1';process.env.DB_USER='test';process.env.DB_NAME='test';
const db=require('../config/db');
const calls=[];
db.query=async(sql,params)=>{calls.push({sql,params});if(sql.includes('AS prescriptions')) return [{total:27,completed:19,prescriptions:16}];return sql.includes('COUNT(*) AS total')?[{total:0}]:[];};
const {listMyAppointments}=require('../controllers/v1/appointmentController');
test('registration-number search remains restricted to the logged-in patient and uses bound parameters',async()=>{
    await new Promise((resolve,reject)=>listMyAppointments({user:{id:42,role:'patient'},query:{search:'DTH_8638'}},{status(){return this;},json:resolve},reject));
    const count=calls.find(row=>row.sql.includes('COUNT(*) AS total') && row.sql.includes('FROM tbl_appointments a'));
    assert.match(count.sql,/WHERE a\.fk_patient_id = \? AND \(/);
    assert.match(count.sql,/reg\.id = a\.fk_patient_id AND reg\.uuid LIKE \?/);
    assert.deepEqual(count.params,[42,...Array(5).fill('%DTH_8638%')]);
    assert.ok(!count.sql.includes('DTH_8638'));
});

test('dashboard upcoming drill-down filters before pagination, sorts nearest first and returns full summary',async()=>{
    calls.length=0;
    const result=await new Promise((resolve,reject)=>listMyAppointments({user:{id:42,role:'patient'},query:{view:'upcoming',page_size:'1'}},{status(){return this;},json:resolve},reject));
    const count=calls.find(row=>row.sql.includes('COUNT(*) AS total') && row.sql.includes('JOIN master_clinic_branches'));
    assert.match(count.sql,/a\.fk_patient_id = \? AND a\.status IN \('Confirmed', 'Pending'\) AND a\.appointment_date >= \?/);
    assert.equal(count.params[0],42);
    assert.match(count.params[1],/^\d{4}-\d{2}-\d{2}$/);
    const list=calls.find(row=>row.sql.includes('LIMIT 1 OFFSET 0'));
    assert.match(list.sql,/ORDER BY a\.appointment_date ASC, s\.start_time ASC/);
    assert.deepEqual(result.meta.summary,{total:27,completed:19,prescriptions:16});
});

test('completed drill-down keeps patient scope and excludes other appointment statuses before pagination',async()=>{
    calls.length=0;
    await new Promise((resolve,reject)=>listMyAppointments({user:{id:42,role:'patient'},query:{view:'completed'}},{status(){return this;},json:resolve},reject));
    const count=calls.find(row=>row.sql.includes('COUNT(*) AS total') && row.sql.includes('JOIN master_clinic_branches'));
    assert.match(count.sql,/WHERE a\.fk_patient_id = \? AND a\.status = 'Completed'/);
    assert.deepEqual(count.params,[42]);
});
