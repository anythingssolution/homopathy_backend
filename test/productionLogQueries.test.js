const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const AppError=require('../utils/AppError');
const suggestionSource=fs.readFileSync(require.resolve('../controllers/v1/doctor/consultationController'),'utf8');
const start=suggestionSource.indexOf('const getPrescriptionSuggestions =');
const end=suggestionSource.indexOf('\nmodule.exports',start);
const loadSuggestions=query=>vm.runInNewContext(`${suggestionSource.slice(start,end)}; getPrescriptionSuggestions`,{query,AppError,asyncHandler:fn=>fn});
async function invoke(handler,request){let response;await handler(request,{status(){return this;},json(value){response=value;}});return response;}

test('both suggestion searches deduplicate and order by aggregate recency without invalid DISTINCT',async()=>{
 const queries=[];
 const handler=loadSuggestions(async(sql,params)=>{
  assert.equal((sql.match(/\?/g)||[]).length,params.length);
  if(sql.startsWith('SELECT fk_patient_id'))return [{fk_patient_id:7}];
  queries.push(sql);
  assert.match(sql,/GROUP BY TRIM\(c.quick_formula_input\)/);
  assert.match(sql,/ORDER BY MAX\(c.created_at\) DESC, MAX\(c.id\) DESC LIMIT 50/);
  assert.doesNotMatch(sql,/SELECT DISTINCT/);
  return queries.length===1?[]:[{quick_formula_input:'36Q'},{quick_formula_input:' 36Q '}];
 });
 const result=await invoke(handler,{query:{appointment_id:1,symptoms:'headache',diagnosis:'pain'}});
 assert.equal(queries.length,2);assert.equal(result.basis,'GLOBAL_HISTORY');assert.deepEqual(Array.from(result.data),['36Q']);
});
test('matching patient history keeps priority and empty input runs no suggestions query',async()=>{
 let searches=0;
 const handler=loadSuggestions(async sql=>sql.startsWith('SELECT fk_patient_id')?[{fk_patient_id:7}]:(searches++,[{quick_formula_input:'24'}]));
 const result=await invoke(handler,{query:{appointment_id:1,symptoms:'pain'}});
 assert.equal(result.basis,'PATIENT_HISTORY');assert.equal(searches,1);
 const empty=await invoke(handler,{query:{appointment_id:1}});assert.equal(empty.data.length,0);assert.equal(searches,1);
});

test('real DB strict SQL: patient/global suggestions and actual family-member edit',{
 skip:process.env.RUN_CLINIC_LOG_DB_TEST!=='1',
},async()=>{
 require('dotenv').config();const mysql=require('mysql2/promise');
 const db=await mysql.createConnection({host:process.env.DB_HOST,port:process.env.DB_PORT,user:process.env.DB_USER,password:process.env.DB_PASSWORD,database:process.env.DB_NAME});
 const names=['master_users','tbl_appointments','tbl_consultations','tbl_patient_family_members','log_user_profile_updates'];
 const tables=Object.fromEntries(names.map((n,i)=>[n,`codex_log_${i}_${Date.now()}_${process.pid}`]));
 const execute=(sql,params=[])=>{for(const[n,t]of Object.entries(tables))sql=sql.replaceAll(n,t);return db.execute(sql,params);};
 const query=async(sql,params)=>(await execute(sql,params))[0];
 const withTransaction=async fn=>{await db.beginTransaction();try{const out=await fn({execute});await db.commit();return out;}catch(e){await db.rollback();throw e;}};
 try{
  await db.query("SET SESSION sql_mode='STRICT_TRANS_TABLES,ONLY_FULL_GROUP_BY,NO_ENGINE_SUBSTITUTION'");
  await db.query(`CREATE TEMPORARY TABLE ${tables.master_users}(id INT PRIMARY KEY,uuid VARCHAR(36),full_name VARCHAR(100),mobile_no VARCHAR(20),gender VARCHAR(10),age INT,date_of_birth DATE,address TEXT,area_name VARCHAR(100),ward_no VARCHAR(50),vidhan_sabha VARCHAR(100),state_name VARCHAR(100),pincode VARCHAR(10),city VARCHAR(100),role VARCHAR(10),is_active INT,updated_at DATETIME,email VARCHAR(100),description TEXT,created_at DATETIME,updated_by INT,updated_ip VARCHAR(45)) ENGINE=InnoDB`);
  await db.query(`CREATE TEMPORARY TABLE ${tables.tbl_appointments}(appointment_id INT PRIMARY KEY,fk_patient_id INT,fk_branch_id INT,is_active INT) ENGINE=InnoDB`);
  await db.query(`CREATE TEMPORARY TABLE ${tables.tbl_consultations}(id INT PRIMARY KEY,appointment_id INT,quick_formula_input VARCHAR(200),symptoms TEXT,disease TEXT,diagnosis TEXT,created_at DATETIME) ENGINE=InnoDB`);
  await db.query(`CREATE TEMPORARY TABLE ${tables.tbl_patient_family_members}(id INT PRIMARY KEY,fk_primary_patient_id INT,full_name VARCHAR(100),age INT,date_of_birth DATE,gender VARCHAR(10),description TEXT,is_active INT) ENGINE=InnoDB`);
  await db.query(`CREATE TEMPORARY TABLE ${tables.log_user_profile_updates}(user_id INT,changed_by_user_id INT,changed_by_role VARCHAR(10),ip_address VARCHAR(45),user_agent TEXT,changed_fields_json TEXT,old_values_json TEXT,new_values_json TEXT) ENGINE=InnoDB`);
  await db.query(`INSERT INTO ${tables.master_users}(id,uuid,full_name,mobile_no,gender,age,city,role,is_active) VALUES(7,'DTH7','Primary','9876543210','male',40,'Raipur','PAT',1)`);
  await db.query(`INSERT INTO ${tables.tbl_appointments} VALUES (1,7,1,1),(2,99,1,1)`);
  await db.query(`INSERT INTO ${tables.tbl_consultations} VALUES
   (1,1,'24','pain','','','2026-01-01'),(2,1,'36Q','pain','','','2026-01-02'),
   (3,1,'24','pain','','','2026-01-03'),(4,2,'global-only','global','','','2026-01-04')`);
  const suggestions=loadSuggestions(query);
  const own=await invoke(suggestions,{query:{appointment_id:1,symptoms:'pain'}});
  assert.equal(own.basis,'PATIENT_HISTORY');assert.deepEqual(Array.from(own.data),['24','36Q']);
  const global=await invoke(suggestions,{query:{appointment_id:1,symptoms:'global'}});
  assert.equal(global.basis,'GLOBAL_HISTORY');assert.deepEqual(Array.from(global.data),['global-only']);
  await db.query(`INSERT INTO ${tables.tbl_patient_family_members} VALUES(8,7,'Family',20,NULL,'female',NULL,1),(9,99,'Other account',20,NULL,'female',NULL,1)`);
  const module={exports:{}};
  vm.runInNewContext(fs.readFileSync(require.resolve('../controllers/v1/doctor/patientUpdateController'),'utf8'),{
   module,require:name=>name==='./shared'?{query,withTransaction,AppError,asyncHandler:fn=>fn,toPositiveInt:Number}:
    name.endsWith('/age')?require('../utils/age'):require('../utils/patientAddressFields'),
  });
  const request=body=>({params:{patient_id:7},selectedBranchId:1,user:{id:2,role_code:'DOC'},headers:{},body});
  const edited=await invoke(module.exports.updateDoctorPatient,request({family_member_id:8,full_name:'Updated family'}));
  assert.equal(edited.data.patient.full_name,'Updated family');
  const [[primary]]=await db.query(`SELECT full_name,uuid FROM ${tables.master_users} WHERE id=7`);
  assert.deepEqual(primary,{full_name:'Primary',uuid:'DTH7'});
  const unchanged=await invoke(module.exports.updateDoctorPatient,request({family_member_id:8,full_name:'Updated family'}));
  assert.equal(unchanged.data.unchanged,true);
  const [[count]]=await db.query(`SELECT COUNT(*) count FROM ${tables.log_user_profile_updates}`);assert.equal(count.count,1);
  await assert.rejects(invoke(module.exports.updateDoctorPatient,request({family_member_id:9,full_name:'Forbidden'})),e=>e.statusCode===404);
 }finally{await db.end();}
});
