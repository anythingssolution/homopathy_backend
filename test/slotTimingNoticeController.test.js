const test=require('node:test');
const assert=require('node:assert/strict');
process.env.JWT_SECRET='timing-notice-test';process.env.DB_HOST='127.0.0.1';process.env.DB_USER='test';process.env.DB_NAME='test';
const db=require('../config/db');
let sample=null;const calls=[];
db.query=async(sql,params)=>{
    calls.push({sql,params});
    if(sql.includes('FROM tbl_appointments a')) return sample ? [sample] : [];
    return [{id:1,new_data_json:{patient_timing_notice:{version:1,old_slot_start:'18:00:00',new_slot_start:'19:00:00',updates:[{appointment_id:9,old_planned_at:'2026-10-20 18:20:00',new_planned_at:'2026-10-20 19:20:00'}]}}}];
};
const {getTimingChangeDraft}=require('../controllers/v1/slotTimingNoticeController');
const invoke=()=>new Promise((resolve,reject)=>getTimingChangeDraft({params:{appointment_id:'9'},selectedBranchId:2},{set(){},status(){return this;},json:resolve},reject));
test('draft detail requires appointment and selected branch and returns no data for another branch',async()=>{
    sample=null;calls.length=0;
    await assert.rejects(invoke(),/Appointment not found in selected branch/);
    assert.match(calls[0].sql,/WHERE a\.appointment_id = \? AND a\.fk_branch_id = \?/);
    assert.deepEqual(calls[0].params,[9,2]);assert.equal(calls.length,1);
});
test('family draft names visiting patient but sends to preferred account WhatsApp contact',async()=>{
    sample={appointment_id:9,fk_branch_id:2,fk_slot_id:3,notice_date:'2026-10-20',appointment_date:'2026-10-20',is_active:1,status:'Confirmed',queue_status:'BOOKED',notice_planned_at:'2026-10-20 19:20:00',patient_full_name:'Child Sample',primary_patient_full_name:'Parent Sample',is_family_member_booking:1,patient_mobile_no:'9876543210',whatsapp_number:'9123456789',branch_name:'Sample Branch',current_token_number:4,original_token_number:4,slot_name:'Evening Session',start_time:'18:00:00'};
    const result=await invoke();
    assert.equal(result.data.patient_name,'Child Sample');assert.equal(result.data.contact_name,'Parent Sample');
    assert.equal(result.data.phone,'919123456789');assert.equal(result.data.is_family_member_booking,true);
    assert.match(result.data.message,/Child Sample ji/);
    sample={...sample,status:'Cancelled'};
    await assert.rejects(invoke(),/No current timing update/);
});
