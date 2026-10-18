const test=require('node:test');
const assert=require('node:assert/strict');
process.env.JWT_SECRET='timing-save-test';process.env.DB_HOST='127.0.0.1';process.env.DB_USER='test';process.env.DB_NAME='test';
let state;let emitted;let failNotice;
const db=require('../config/db');
const connection={execute:async(sql,params)=>{
    if(sql.includes('SELECT appointment_id, is_active')) return [[{appointment_id:1,is_active:1,status:'Confirmed',queue_status:'BOOKED',planned_start_at:state.planned}]];
    if(sql.includes('INSERT INTO tbl_doctor_slot_time_overrides')) {state.start=params[5];state.has=true;return [{insertId:42}];}
    if(sql.includes('SELECT COUNT(*)')) return [[{total:1}]];
    if(sql.includes('INSERT INTO tbl_doctor_slot_time_override_audit_logs')) {state.audit={id:state.audit.id+1,new_data_json:JSON.parse(params[5])};return [{}];}
    if(sql.includes('SELECT id, new_data_json')) return [[state.audit]];
    if(sql.includes('UPDATE tbl_doctor_slot_time_override_audit_logs')) {if(failNotice) throw new Error('snapshot write failed');state.audit.new_data_json=JSON.parse(params[0]);return [{}];}
    throw new Error(`Unexpected SQL: ${sql}`);
}};
db.withTransaction=async(fn)=>{const previous=structuredClone(state);try{return await fn(connection);}catch(e){state=previous;throw e;}};
const timing=require('../services/slotTimeOverrideService');
timing.resolveEffectiveSlotTiming=async()=>({defaultStartTime:'18:00:00',defaultEndTime:'21:00:00',effectiveStartTime:state.start,hasOverride:state.has,overrideId:state.has?42:null});
timing.shiftActiveExtensionTokenTimes=async()=>0;
const queue=require('../services/liveQueueService');
queue.recalculateQueuePlan=async()=>{state.planned=`2099-10-20 ${state.start.slice(0,2)}:20:00`;};
queue.emitLiveQueueEvent=async()=>{emitted++;};
const recurring=require('../services/recurringScheduleService');
recurring.assertSlotTimingCanShift=async()=>{};
timing.findRecurringRuleForSlot=async()=>null;
recurring.cancelSlotOverrideForDate=async()=>{state.start='18:00:00';state.has=false;await queue.recalculateQueuePlan();state.audit={id:state.audit.id+1,new_data_json:{reset:true}};return {changed:true};};
const {saveSlotTiming,resetSlotTiming}=require('../controllers/v1/doctorSlotTimeOverrideController');
const invoke=(fn)=>new Promise((resolve,reject)=>fn({selectedBranchId:1,user:{id:7},query:{},body:{slot_id:2,appointment_date:'2099-10-20',override_start_time:'19:00'},headers:{}},{status(){return this;},json:resolve},reject));
test('successful doctor shift and reset attach old/new patient snapshots to their existing audits',async()=>{
    state={start:'18:00:00',has:false,planned:'2099-10-20 18:20:00',audit:{id:0}};emitted=0;failNotice=false;
    await invoke(saveSlotTiming);
    let notice=state.audit.new_data_json.patient_timing_notice;
    assert.deepEqual(notice.updates,[{appointment_id:1,old_planned_at:'2099-10-20 18:20:00',new_planned_at:'2099-10-20 19:20:00'}]);
    assert.equal(emitted,1);
    await invoke(resetSlotTiming);
    notice=state.audit.new_data_json.patient_timing_notice;
    assert.equal(notice.new_slot_start,'18:00:00');assert.equal(notice.updates[0].old_planned_at,'2099-10-20 19:20:00');assert.equal(notice.updates[0].new_planned_at,'2099-10-20 18:20:00');
    assert.equal(emitted,2);
});
test('a failed transaction rolls back timing and audit without emitting a successful update',async()=>{
    state={start:'18:00:00',has:false,planned:'2099-10-20 18:20:00',audit:{id:0}};emitted=0;failNotice=true;
    await assert.rejects(invoke(saveSlotTiming),/snapshot write failed/);
    assert.equal(state.start,'18:00:00');assert.equal(state.audit.id,0);assert.equal(emitted,0);
});
