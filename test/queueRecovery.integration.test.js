const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const AppError=require('../utils/AppError');
const {isRetryableTransactionError}=require('../utils/transactionRetry');
const enabled=process.env.RUN_CLINIC_LOG_DB_TEST==='1';
const definition=(source,name)=>{const a=source.indexOf(`const ${name} =`),b=source.indexOf('\nconst ',a+7);return source.slice(a,b<0?source.length:b);};
function loadTransaction(pool){
 const module={exports:{}};
 vm.runInNewContext(fs.readFileSync(require.resolve('../config/db'),'utf8'),{module,setTimeout,
  require:name=>name==='mysql2/promise'?{createPool:()=>pool}:name==='./env'?{env:{db:{}}}:{isRetryableTransactionError},
 });return module.exports.withTransaction;
}
function createPool(){require('dotenv').config();return require('mysql2/promise').createPool({
 host:process.env.DB_HOST,port:process.env.DB_PORT,user:process.env.DB_USER,password:process.env.DB_PASSWORD,
 database:process.env.DB_NAME,connectionLimit:2,dateStrings:true,
});}

test('real InnoDB deadlock: rollback/retry commits both transactions exactly once', {skip:!enabled,timeout:20000},async()=>{
 const pool=createPool(),table=`codex_deadlock_${Date.now()}_${process.pid}`;
 try{
  await pool.query(`CREATE TABLE ${table}(id INT PRIMARY KEY,n INT NOT NULL) ENGINE=InnoDB`);
  await pool.query(`INSERT INTO ${table} VALUES(1,0),(2,0)`);
  const withTransaction=loadTransaction(pool);
  let ready=0,release;const barrier=new Promise(resolve=>{release=resolve;});
  const attempts=[0,0],committed=[];
  const run=async index=>{
   await withTransaction(async c=>{
    attempts[index]++;const first=index+1,second=index===0?2:1;
    await c.execute(`UPDATE ${table} SET n=n+1 WHERE id=?`,[first]);
    if(attempts[index]===1){ready++;if(ready===2)release();await barrier;}
    await c.execute(`UPDATE ${table} SET n=n+1 WHERE id=?`,[second]);
   },{maxRetries:2});committed.push(index);
  };
  await Promise.all([run(0),run(1)]);
  const [rows]=await pool.query(`SELECT n FROM ${table} ORDER BY id`);
  assert.deepEqual(rows.map(r=>r.n),[2,2]);assert.equal(committed.length,2);
  assert.equal(attempts[0]+attempts[1],3,'one real deadlock victim must replay');
 }finally{await pool.query(`DROP TABLE IF EXISTS ${table}`);await pool.end();}
});

test('two concurrent durable workers call and broadcast only one patient', {skip:!enabled,timeout:20000},async()=>{
 const pool=createPool(),suffix=`${Date.now()}_${process.pid}`;
 const names={tbl_appointments:`codex_queue_apps_${suffix}`,tbl_live_queue_sessions:`codex_queue_sessions_${suffix}`};
 const replace=sql=>{for(const [name,target]of Object.entries(names))sql=sql.replaceAll(name,target);return sql;};
 const wrappedPool={getConnection:async()=>{
  const c=await pool.getConnection();return {
   execute:(sql,params)=>c.execute(replace(sql),params),beginTransaction:()=>c.beginTransaction(),
   commit:()=>c.commit(),rollback:()=>c.rollback(),release:()=>c.release(),
  };
 }};
 try{
  await pool.query(`CREATE TABLE ${names.tbl_appointments}(appointment_id INT PRIMARY KEY,fk_branch_id INT,fk_slot_id INT,appointment_date DATE,called INT NOT NULL DEFAULT 0) ENGINE=InnoDB`);
  await pool.query(`CREATE TABLE ${names.tbl_live_queue_sessions}(id INT PRIMARY KEY,fk_branch_id INT,fk_slot_id INT,appointment_date DATE,session_status VARCHAR(25),current_appointment_id INT,auto_call_next_due_at DATETIME,auto_call_next_reason VARCHAR(100)) ENGINE=InnoDB`);
  await pool.query(`INSERT INTO ${names.tbl_appointments} VALUES(7,1,1,'2026-11-01',0)`);
  await pool.query(`INSERT INTO ${names.tbl_live_queue_sessions} VALUES(1,1,1,'2026-11-01','RUNNING',NULL,DATE_SUB(NOW(),INTERVAL 1 SECOND),'TEST')`);
  const serviceSource=fs.readFileSync(require.resolve('../services/liveQueueService'),'utf8');
  const lock=vm.runInNewContext(`${definition(serviceSource,'getExecutor')}\n${definition(serviceSource,'lockQueueAppointments')}\nlockQueueAppointments`,{});
  const workerSource=fs.readFileSync(require.resolve('../services/liveQueueAutomationService'),'utf8');
  let calls=0,broadcasts=0;
  const worker=vm.runInNewContext(`${definition(workerSource,'processSingleDueAutoCallNext')}\nprocessSingleDueAutoCallNext`,{
   AppError,withTransaction:loadTransaction(wrappedPool),lockQueueAppointments:lock,
   autoSelectAndCallNextReady:async c=>{
    await c.execute('UPDATE tbl_appointments SET called=called+1 WHERE appointment_id=7');
    await c.execute('UPDATE tbl_live_queue_sessions SET current_appointment_id=7 WHERE id=1');
    calls++;return {branchId:1,slotId:1,appointmentDate:'2026-11-01',appointmentId:7,tokenNumber:7};
   },recalculateLiveRuntimeProjection:async()=>{},emitLiveQueueEvent:async()=>{broadcasts++;},
  });
  const scope={branchId:1,slotId:1,appointmentDate:'2026-11-01'};
  await Promise.all([worker(scope),worker(scope)]);
  const [[appointment]]=await pool.query(`SELECT called FROM ${names.tbl_appointments}`);
  const [[session]]=await pool.query(`SELECT current_appointment_id,auto_call_next_due_at FROM ${names.tbl_live_queue_sessions}`);
  assert.equal(appointment.called,1);assert.equal(calls,1);assert.equal(broadcasts,1);
  assert.equal(session.current_appointment_id,7);assert.equal(session.auto_call_next_due_at,null);
 }finally{for(const table of Object.values(names))await pool.query(`DROP TABLE IF EXISTS ${table}`);await pool.end();}
});
