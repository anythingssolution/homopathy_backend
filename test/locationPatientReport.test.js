const test=require('node:test');
const assert=require('node:assert/strict');
const sharedPath=require.resolve('../services/reports/shared');
const reportPath=require.resolve('../services/reports/patient/locationPatients');

test('location reports keep branch/date scope and count people independently from consultations',async(t)=>{
  const original=require.cache[sharedPath];const calls=[];
  require.cache[sharedPath]={id:sharedPath,filename:sharedPath,loaded:true,exports:{query:async(sql,params)=>{
    calls.push({sql,params});
    if(sql.includes('FROM tbl_consultations c')) return [
      {patient_id:1,patient_full_name:'Primary',consultation_id:10,consultation_date:'2026-10-01'},
      {patient_id:1,patient_full_name:'Primary',consultation_id:11,consultation_date:'2026-10-03'},
      {patient_id:1,family_member_id:5,patient_full_name:'Family',consultation_id:12,consultation_date:'2026-10-02'},
    ];
    if(sql.includes('FROM master_users p WHERE'))return [{patient_id:1,patient_full_name:'Primary'}];
    return [{patient_id:1,family_member_id:5,patient_full_name:'Family'}];
  }}};
  delete require.cache[reportPath];
  t.after(()=>{delete require.cache[reportPath];if(original)require.cache[sharedPath]=original;else delete require.cache[sharedPath];});
  const {getLocationPatients}=require(reportPath);
  const result=await getLocationPatients({branchId:2,fromDate:'2026-10-01',toDate:'2026-10-15'});
  assert.equal(result.consulted.length,2);assert.equal(result.consulted[0].consultations,2);
  assert.equal(result.consulted[0].last_consultation,'2026-10-03');
  assert.equal(result.consulted[1].address_inherited,true);
  assert.equal(result.registered[0].consultations,2);assert.equal(result.registered[1].consultations,1);
  assert.deepEqual(calls[0].params,[2,'2026-10-01','2026-10-15']);
  assert.match(calls[0].sql,/a.status='Completed'/);
  assert.match(calls[0].sql,/a.is_active=1/);
  assert.deepEqual(calls[1].params,['2026-10-01','2026-10-15',2,2]);
  assert.match(calls[1].sql,/bb.fk_branch_id = \?/);
  assert.deepEqual(calls[2].params,['2026-10-01','2026-10-15',2]);
  assert.equal(result.all.length,2);
  assert.deepEqual(calls[3].params,[2,2]);
  assert.deepEqual(calls[4].params,[2,2]);
  for (const call of calls.slice(3)) {
    assert.doesNotMatch(call.sql,/created_at>=/);
    assert.match(call.sql,/AS can_open_record/);
    assert.doesNotMatch(call.sql,/AND EXISTS/);
  }
  await assert.rejects(getLocationPatients({branchId:null}),/select a branch/);
});
