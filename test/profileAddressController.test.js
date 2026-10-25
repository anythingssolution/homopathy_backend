const test=require('node:test');
const assert=require('node:assert/strict');
process.env.JWT_SECRET='profile-address-test';process.env.DB_HOST='127.0.0.1';process.env.DB_USER='test';process.env.DB_NAME='test';
const db=require('../config/db');
let row={id:42,uuid:'REG42',full_name:'Fixture',role:'PAT',area_name:'Mowa',city:'Raipur',pincode:'492001',address:'Mowa, 492001, Raipur',ward_no:null,vidhan_sabha:null};
let audit=[];
db.query=async sql=>{assert.match(sql,/area_name[\s\S]*pincode[\s\S]*city/);return [{...row}];};
db.withTransaction=async handler=>{
    const original={...row},oldAudit=[...audit];
    try{return await handler({execute:async(sql,params)=>{
        if(sql.includes('SELECT')&&sql.includes('FROM master_users')) return [[{...row}]];
        if(sql.includes('UPDATE master_users')) {assert.equal(params.at(-1),42);const fields=sql.match(/SET ([\s\S]+)WHERE id/)[1].split(',').map(v=>v.trim().split(' ')[0]);fields.forEach((field,i)=>{row[field]=params[i];});return [{affectedRows:1}];}
        if(sql.includes('INSERT INTO log_user_profile_updates')) {audit.push(params);return [{insertId:1}];}
        throw new Error('Unexpected query');
    }});}catch(e){row=original;audit=oldAudit;throw e;}
};
const {updateCurrentPatientProfile,getCurrentPatient}=require('../controllers/v1/authController');
const invoke=(fn,body={})=>new Promise((resolve,reject)=>fn({body,user:{id:42,role:'patient',role_code:'PAT'},headers:{},ip:'127.0.0.1'},{status(){return this;},json:resolve},reject));
test('PATCH /me saves structured and full address together, audits fields, and GET returns saved values',async()=>{
    const saved=await invoke(updateCurrentPatientProfile,{area_name:'Shankar Nagar',city:'Raipur',pincode:'492007'});
    assert.equal(saved.data.address,'Shankar Nagar, 492007, Raipur');
    assert.equal(saved.data.area_name,'Shankar Nagar');
    assert.ok(JSON.parse(audit.at(-1)[5]).includes('area_name'));assert.ok(JSON.parse(audit.at(-1)[5]).includes('pincode'));
    const loaded=await invoke(getCurrentPatient);assert.equal(loaded.data.city,'Raipur');assert.equal(loaded.data.pincode,'492007');
    const before={...row},count=audit.length;
    await assert.rejects(invoke(updateCurrentPatientProfile,{city:'',pincode:'492001'}),{statusCode:400});
    assert.deepEqual(row,before);assert.equal(audit.length,count);
});

test('profile ward / assembly update is returned, audited and survives unrelated edits',async()=>{
    const saved=await invoke(updateCurrentPatientProfile,{ward_no:'12',vidhan_sabha:'Raipur West'});
    assert.equal(saved.data.ward_no,'12');assert.equal(saved.data.vidhan_sabha,'Raipur West');
    assert.ok(saved.data.address.includes('Ward 12, Raipur West'));
    const changed=JSON.parse(audit.at(-1)[5]);assert.ok(changed.includes('ward_no'));assert.ok(changed.includes('vidhan_sabha'));
    const loaded=await invoke(getCurrentPatient);assert.equal(loaded.data.ward_no,'12');
    await invoke(updateCurrentPatientProfile,{full_name:'Changed name'});
    assert.equal(row.ward_no,'12');assert.equal(row.vidhan_sabha,'Raipur West');
    await invoke(updateCurrentPatientProfile,{ward_no:'',vidhan_sabha:null});
    assert.equal(row.ward_no,null);assert.equal(row.vidhan_sabha,null);assert.ok(!row.address.includes('Ward 12'));
});
