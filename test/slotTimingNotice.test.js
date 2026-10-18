const test = require('node:test');
const assert = require('node:assert/strict');
const { recordTimingNotice, matchingUpdate, attachTimingNotices, normalizeWhatsAppPhone, buildTimingDraft } = require('../services/slotTimingNoticeService');
const row = (id, planned = '2026-10-20 19:20:00') => ({ appointment_id: id, fk_branch_id: 1, fk_slot_id: 2, notice_date: '2026-10-20', appointment_date: '2026-10-20', is_active: 1, status: 'Confirmed', reception_status: 'PENDING', queue_status: 'BOOKED', planned_start_at: planned, notice_planned_at: planned, patient_full_name: 'Sample Patient', patient_mobile_no: '9876543210', branch_name: 'Lily Chowk', display_token_display: 'E-23' });
const notice = { id: 12, version: 1, old_slot_start: '18:00:00', new_slot_start: '19:00:00', updates: [{ appointment_id: 1, old_planned_at: '2026-10-20 18:20:00', new_planned_at: '2026-10-20 19:20:00' }] };

test('audit snapshots include only existing eligible appointments with changed planned times', async () => {
    const writes=[];
    const connection={execute:async(sql,params)=>{
        if(sql.includes('FROM tbl_appointments')) return [[row(1),row(2),{...row(3),status:'Cancelled'},row(4),row(5)]];
        if(sql.includes('SELECT id, new_data_json')) return [[{id:12,new_data_json:JSON.stringify({shiftSeconds:3600})}]];
        writes.push({sql,params});return [{}];
    }};
    await recordTimingNotice(connection,{context:{branchId:1,slotId:2,appointmentDate:'2026-10-20'}, before:[row(1,'2026-10-20 18:20:00'),row(4),row(5,null)],oldStart:'18:00:00',newStart:'19:00:00'});
    const data=JSON.parse(writes[0].params[0]);
    assert.equal(data.shiftSeconds,3600);
    assert.deepEqual(data.patient_timing_notice.updates.map(item=>item.appointment_id),[1,5]);
    assert.equal(data.patient_timing_notice.updates[1].old_planned_at,null);
    assert.deepEqual(writes[0].params.slice(1),[12]);
});
test('same start time produces no new patient notice',async()=>{
    await recordTimingNotice({execute:()=>{throw new Error('must not query');}},{oldStart:'18:00:00',newStart:'18:00:00'});
});
test('current notice rejects cancellations completed visits re-plans and bookings made after shift',()=>{
    assert.ok(matchingUpdate(row(1),notice));
    for(const item of [{...row(1),status:'Cancelled'},{...row(1),status:'Completed'},{...row(1),is_active:0},{...row(1),reception_status:'REJECTED_BY_RECEPTION'},row(1,'2026-10-20 19:30:00'),row(2)]) assert.equal(matchingUpdate(item,notice),null);
});
test('repeated shift/reset uses newest audit snapshot and preserves branch/date scope',async()=>{
    const calls=[];
    const query=async(sql,params)=>{calls.push({sql,params});return [{id:22,new_data_json:JSON.stringify({patient_timing_notice:{...notice,updates:[{appointment_id:1,old_planned_at:'2026-10-20 19:20:00',new_planned_at:'2026-10-20 18:20:00'}]}})}];};
    const rows=await attachTimingNotices(query,[row(1,'2026-10-20 18:20:00'),row(2,'2026-10-20 18:30:00')]);
    assert.equal(rows[0].timing_change.change_id,22);assert.equal(rows[1].timing_change,null);
    assert.equal(calls.length,1);assert.deepEqual(calls[0].params,[1,2,'2026-10-20']);
    assert.match(calls[0].sql,/ORDER BY id DESC LIMIT 1/);
});
test('late early and future-date drafts use saved times and encode correct recipient',()=>{
    const change=matchingUpdate(row(1),notice);
    const later=buildTimingDraft(row(1),change);
    assert.match(later.message,/20\/10\/2026/);assert.match(later.message,/1 ghanta baad/);
    assert.match(later.message,/6:20 PM se badalkar 7:20 PM/);assert.match(later.whatsapp_url,/^https:\/\/wa.me\/919876543210\?text=/);
    assert.equal(decodeURIComponent(later.whatsapp_url.split('?text=')[1]),later.message);
    const early=buildTimingDraft(row(1),{...change,old_slot_start:'18:00:00',new_slot_start:'17:30:00',new_planned_at:'2026-10-20 17:50:00'});
    assert.match(early.message,/30 minute pehle/);assert.match(early.message,/5:50 PM/);
});
test('missing historical time is not invented and invalid contact cannot launch WhatsApp',()=>{
    const draft=buildTimingDraft({...row(1),patient_mobile_no:'123'},{...matchingUpdate(row(1),notice),old_planned_at:null});
    assert.equal(draft.whatsapp_url,null);assert.equal(draft.old_time,null);assert.match(draft.message,/updated planned consultation time/);assert.doesNotMatch(draft.message,/se badalkar/);
});
test('recipient normalization accepts India and international numbers but rejects invalid numbers',()=>{
    assert.equal(normalizeWhatsAppPhone('+91 98765 43210'),'919876543210');
    assert.equal(normalizeWhatsAppPhone('09876543210'),'919876543210');
    assert.equal(normalizeWhatsAppPhone('00447912345678'),'447912345678');
    assert.equal(normalizeWhatsAppPhone('12345'),null);assert.equal(normalizeWhatsAppPhone('0000000000'),null);
});
