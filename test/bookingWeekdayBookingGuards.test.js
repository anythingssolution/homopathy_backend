const test = require('node:test');
const assert = require('node:assert/strict');
process.env.JWT_SECRET='weekday-controller-test'; process.env.DB_HOST='127.0.0.1';process.env.DB_USER='test';process.env.DB_NAME='test';
const db = require('../config/db');
let writes = [];
const execute = async sql => {
    if (/\b(INSERT|UPDATE|DELETE)\b/.test(sql)) {writes.push(sql);throw new Error('Unexpected mutation');}
    if (sql.includes('FROM master_slots')) return [[{id:3}]];
    if (sql.includes('FROM tbl_branch_slot_booking_weekdays')) return [Array.from({length:7},(_,i)=>({fk_slot_id:3,day_of_week:i+1,booking_enabled:0}))];
    return [[]];
};
db.query = async sql => (await execute(sql))[0];
db.withTransaction = async handler => handler({execute});
const patient = require('../controllers/v1/appointmentController');
const reception = require('../controllers/v1/receptionistController');
const invoke = (fn,req) => new Promise((resolve,reject)=>fn(req,{status(){return this;},json:resolve},reject));
const body={fk_branch_id:2,fk_slot_id:3,fk_treatment_id:1,appointment_date:'2099-01-01',booking_for:'SELF'};
test('closed weekday rejects patient, reception and reschedule before any patient, bill or appointment write', async () => {
    for(const [fn,extra] of [
        [patient.createAppointment,{}],
        [reception.createAppointmentByReceptionist,{body:{...body,patient:{full_name:'Fixture',mobile_no:'9999999999',age:25,gender:'male'}}}],
        [reception.rescheduleAppointmentByReceptionist,{params:{appointment_id:'10'}}],
    ]) {
        writes=[];
        await assert.rejects(invoke(fn,{body,user:{id:1},params:{},headers:{},ip:'127.0.0.1',...extra}),e=>e.statusCode===409&&e.details?.code==='BOOKING_WEEKDAY_CLOSED');
        assert.deepEqual(writes,[]);
    }
});
test('token plate cannot present tokens from a closed weekday', async () => {
    await assert.rejects(invoke(patient.getBookingTokenPlate,{query:{branch_id:'2',slot_id:'3',treatment_id:'1',appointment_date:'2099-01-01'},user:{id:1}}), e=>e.statusCode===409&&e.details?.code==='BOOKING_WEEKDAY_CLOSED');
});
