const test = require('node:test');
const assert = require('node:assert/strict');
process.env.JWT_SECRET = 'billing-read-test';
process.env.DB_HOST = '127.0.0.1';
process.env.DB_USER = 'test';
process.env.DB_NAME = 'test';
const db = require('../config/db');
let calls=[];
db.query=async(sql,params)=>{
 calls.push({sql,params});
 if(sql.includes('SELECT fk_branch_id'))return [{fk_branch_id:2}];
 if(sql.includes('COUNT(*) AS total'))return [{total:0}];
 return [];
};
const billing = require('../services/billingService');
billing.getBillDetailById=async()=>({bill_id:10,bill_type:'CONSULTATION',appointment_id:null,branch_id:1});
billing.getAppointmentBillingSummaryByAppointmentId=async()=>({doctor_id:null,appointment:{branch_id:1},bills:[]});
const controller=require('../controllers/v1/billController');
const middleware=require('../middleware/authMiddleware');
const req=(extra={})=>({user:{id:5,role:'doctor',role_code:'DOC',selected_branch_id:1},selectedBranchId:1,params:{bill_id:10,appointment_id:20},query:{branch_id:'1',billing_scope:'branch'},...extra});
const invoke=(fn,request)=>new Promise((resolve,reject)=>fn(request,{status(){return this;},json:resolve},reject));

test('branch bill list includes unassigned and repeat bills; original doctor list keeps its scope',async()=>{
 calls=[];await invoke(controller.listBills,req());
 assert.ok(calls.every(c=>c.sql.includes('b.fk_branch_id = ?')));
 assert.ok(calls.every(c=>!c.sql.includes('c.doctor_id = ?')));
 calls=[];await invoke(controller.listBills,req({query:{branch_id:'1'}}));
 assert.ok(calls.every(c=>c.sql.includes('c.doctor_id = ?')));
 calls=[];await invoke(controller.listBills,req({selectedBranchId:null}));
 assert.ok(calls.every(c=>c.sql.includes('c.doctor_id = ?')));
});
test('patient cannot use branch billing to escape ownership',async()=>{
 calls=[];await invoke(controller.listBills,req({user:{id:8,role:'patient'}}));
 assert.ok(calls.every(c=>c.sql.includes('b.patient_id = ?')));
});
test('selected branch detail permits no-consultation bills but original detail remains restricted',async()=>{
 assert.equal((await invoke(controller.getBillById,req())).data.bill_id,10);
 await assert.rejects(invoke(controller.getBillById,req({query:{}})),/not authorized/);
 assert.ok((await invoke(controller.getAppointmentBillingSummary,req())).success);
});
test('branch middleware still rejects a bill in another branch',async()=>{
 const err=await new Promise(resolve=>middleware.authorizeBillBranchScope(req(),{},resolve));
 assert.equal(err.statusCode,403);
});
test('branch receipt list includes all collection-date payments with branch restriction',async()=>{
 calls=[];await invoke(controller.listBillPayments,req({query:{branch_id:'1',billing_scope:'branch',from_date:'2026-09-08',to_date:'2026-09-08'}}));
 assert.ok(calls.every(c=>c.sql.includes('DATE(bp.collected_at) >= ?')&&c.sql.includes('b.fk_branch_id = ?')));
 assert.ok(calls.every(c=>!c.sql.includes('c.doctor_id = ?')));
});
