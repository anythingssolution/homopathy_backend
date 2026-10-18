const test = require('node:test');
const assert = require('node:assert/strict');

test('dispensary register reconciles bill totals and keeps old pending cases with isolated fixtures', {skip:process.env.RUN_DISPENSARY_REGISTER_DB_TEST!=='1'}, async t => {
    require('dotenv').config({quiet:true});
    const mysql = require('mysql2/promise');
    const db = await mysql.createConnection({host:process.env.DB_HOST,port:process.env.DB_PORT,user:process.env.DB_USER,password:process.env.DB_PASSWORD,database:process.env.DB_NAME});
    t.after(() => db.end());
    const schemas = {
        tbl_appointments:'appointment_id INT PRIMARY KEY,fk_patient_id INT,fk_patient_family_member_id INT NULL,fk_branch_id INT,fk_treatment_id INT,fk_slot_id INT,appointment_date DATE,is_active INT DEFAULT 1,status VARCHAR(30),actual_completed_at DATETIME,original_token_number INT,current_token_number INT',
        tbl_consultations:'id INT PRIMARY KEY,appointment_id INT,doctor_id INT,workflow_status VARCHAR(40),sent_to_medical_at DATETIME,created_at DATETIME',
        master_users:'id INT PRIMARY KEY,uuid VARCHAR(30),full_name VARCHAR(50),mobile_no VARCHAR(20)',
        tbl_patient_family_members:'id INT PRIMARY KEY,full_name VARCHAR(50)',
        master_treatments:'id INT PRIMARY KEY,treatment_name VARCHAR(50)',
        master_slots:'id INT PRIMARY KEY,slot_name VARCHAR(50),start_time TIME',
        tbl_bills:'id INT PRIMARY KEY,bill_number VARCHAR(30),patient_id INT,fk_branch_id INT,consultation_id INT NULL,appointment_id INT NULL,bill_type VARCHAR(30),status VARCHAR(30),remark VARCHAR(80),created_at DATETIME,gross_amount DECIMAL(10,2),discount_amount DECIMAL(10,2),total_amount DECIMAL(10,2),paid_amount DECIMAL(10,2),pending_amount DECIMAL(10,2),payment_status VARCHAR(20),delivery_mode VARCHAR(30)',
        tbl_bill_items:'id INT PRIMARY KEY,bill_id INT,item_type VARCHAR(30),item_name VARCHAR(50)',
    };
    // All tables are connection-local and disappear when this connection closes.
    for(const [name,columns] of Object.entries(schemas)) await db.query(`CREATE TEMPORARY TABLE ${name} (${columns})`);
    const shared = require.resolve('../services/reports/shared');
    const service = require.resolve('../services/reports/medical/dispensaryRegister');
    const original = require.cache[shared];
    require.cache[shared] = {id:shared,filename:shared,loaded:true,exports:{query:async(sql,params)=>(await db.query(sql,params))[0]}};
    delete require.cache[service];
    t.after(() => { delete require.cache[service]; if(original)require.cache[shared]=original;else delete require.cache[shared]; });
    const {getDispensaryRegister} = require(service);
    const scope={branchId:1,fromDate:'2026-10-17',toDate:'2026-10-17'};
    await db.query("INSERT INTO master_users VALUES (1,'REG1','Primary','9999999999'),(2,'REG2','Parent','8888888888'),(99,'DOC','Doctor',NULL)");
    await db.query("INSERT INTO tbl_patient_family_members VALUES (7,'Family')");
    await db.query("INSERT INTO master_treatments VALUES (1,'Consultation')");
    await db.query("INSERT INTO master_slots VALUES (1,'Morning Session','09:00:00')");
    for(const [id,person,family,branch,status,active] of [[1,1,null,1,'Completed',1],[2,1,null,1,'Completed',1],[3,2,7,1,'Completed',1],[4,1,null,2,'Completed',1],[5,1,null,1,'Cancelled',1],[6,1,null,1,'Completed',0]]){
        await db.query('INSERT INTO tbl_appointments VALUES (?,?,?,?,1,1,?, ?,?,?,27,30)',[id,person,family,branch,'2026-01-01',active,status,'2026-01-01 10:00:00']);
        await db.query('INSERT INTO tbl_consultations VALUES (?,?,99,?,?,?)',[id,id,[2,3].includes(id)?'PROCESSED_BY_MEDICAL':'READY_FOR_MEDICAL','2026-01-01 10:00:00','2026-01-01 09:00:00']);
    }
    for(const row of [
        [1,1,1,2,2,'MEDICATION','ACTIVE','Regular','2026-10-17',600,50,550,400,150,'PARTIAL','COURIER'],
        [2,1,1,null,null,'MEDICATION','ACTIVE','Medical Only','2026-10-17',100,0,100,100,0,'PAID','HAND_DELIVERY'],
        [3,2,1,3,null,'MEDICATION','ACTIVE','Repeat Medicine','2026-10-17',200,50,150,0,150,'UNPAID','HAND_DELIVERY'],
        [4,1,1,null,null,'MEDICATION','VOID','Void','2026-10-17',999,0,999,0,999,'UNPAID',null],
        [5,1,1,null,null,'MEDICATION','ACTIVE','Old','2026-01-01',600,0,600,0,600,'UNPAID',null],
        [6,1,1,null,null,'CONSULTATION','ACTIVE','Consult','2026-10-17',500,0,500,500,0,'PAID',null],
        [7,1,2,null,null,'MEDICATION','ACTIVE','Other branch','2026-10-17',500,0,500,0,500,'UNPAID',null],
    ])await db.query('INSERT INTO tbl_bills VALUES (?,?, ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',[row[0],`BILL-${row[0]}`,...row.slice(1)]);
    await db.query("INSERT INTO tbl_bill_items VALUES (1,1,'MEDICATION','17'),(2,1,'MEDICATION','17'),(3,1,'TEST','CBC'),(4,1,'DELIVERY','Courier charge'),(5,2,'ADDITIONAL_MEDICATION','Cream'),(6,3,'MEDICATION','17'),(7,4,'MEDICATION','17')");
    const result=await getDispensaryRegister(scope);
    assert.deepEqual(result.summary,{pending_count:1,dispensed_bills:3,net_billed:800,paid:500,pending:300});
    assert.equal(result.pending[0].consultation_id,1);
    assert.equal(result.pending[0].display_token_display,'M-27');
    assert.ok(result.pending[0].waiting_days>90);
    assert.equal(result.bills.find(row=>row.bill_id===3).patient_full_name,'Family');
    assert.equal(result.bills.find(row=>row.bill_id===3).medicine_type,'REPEAT');
    assert.equal(result.bills.find(row=>row.bill_id===3).display_token_display,null);
    assert.equal(result.bills.find(row=>row.bill_id===2).medicine_type,'DIRECT');
    assert.equal(result.top_medicines.find(row=>row.medicine_name==='17').bill_count,2);
    assert.equal(result.top_medicines.some(row=>row.medicine_name==='CBC'),false);
    assert.equal(result.trend[0].net_billed,800);
});
