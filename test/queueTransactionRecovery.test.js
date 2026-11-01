const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const AppError=require('../utils/AppError');
const {isRetryableTransactionError}=require('../utils/transactionRetry');

function recovery({failures=1,code='ER_LOCK_DEADLOCK',businessError=false,options={maxRetries:2}}={}){
    let state={due:true,called:0},before,attempts=0,commits=0,releases=0;
    const queries=[],emits=[];
    const connection={
        beginTransaction:async()=>{before=structuredClone(state);},
        commit:async()=>{commits++;},rollback:async()=>{state=before;},release:()=>{releases++;},
        execute:async(sql)=>{
            queries.push(sql);
            if(sql.includes('SELECT appointment_id'))return [[]];
            if(sql.includes('SELECT id,'))return [state.due?[{id:1,session_status:'RUNNING',current_appointment_id:null,auto_call_next_reason:'TEST'}]:[]];
            if(sql.includes('UPDATE tbl_live_queue_sessions')){state.due=false;return [{affectedRows:1}];}
            throw Error(sql);
        },
    };
    const module={exports:{}};
    vm.runInNewContext(fs.readFileSync(require.resolve('../config/db'),'utf8'),{module,
        setTimeout:fn=>{fn();},require:name=>name==='mysql2/promise'?{createPool:()=>({getConnection:async()=>connection})}:
            name==='./env'?{env:{db:{}}}:{isRetryableTransactionError}});
    const withTransaction=module.exports.withTransaction;
    const source=fs.readFileSync(require.resolve('../services/liveQueueAutomationService'),'utf8');
    const start=source.indexOf('const processSingleDueAutoCallNext =');
    const end=source.indexOf('\nconst ',start+7);
    const run=vm.runInNewContext(`${source.slice(start,end)}; processSingleDueAutoCallNext`,{
        AppError,withTransaction:(fn,opts)=>withTransaction(fn,{...opts,...options}),
        lockQueueAppointments:async(c)=>c.execute('SELECT appointment_id FROM tbl_appointments ORDER BY appointment_id ASC FOR UPDATE'),
        autoSelectAndCallNextReady:async()=>{
            attempts++;
            if(attempts<=failures)throw businessError?new AppError('No ready patient',409):Object.assign(new Error('transaction failed'),{code});
            state.called++;return {branchId:1,slotId:1,appointmentDate:'2026-11-01',appointmentId:7,tokenNumber:12};
        },recalculateLiveRuntimeProjection:async()=>{},emitLiveQueueEvent:async payload=>emits.push(payload),
    });
    return {run:()=>run({branchId:1,slotId:1,appointmentDate:'2026-11-01'}),
        state:()=>({...state,attempts,commits,releases}),queries,emits,withTransaction};
}
test('deadlock retries the entire job after rollback and emits one committed call',async()=>{
    const f=recovery();await f.run();
    assert.deepEqual(f.state(),{due:false,called:1,attempts:2,commits:1,releases:2});
    assert.equal(f.emits.length,1);
    assert.equal(f.queries.filter(q=>q.startsWith('UPDATE')).length,1,'failed transaction must not clear schedule');
    assert.match(f.queries[0],/FROM tbl_appointments/);
    assert.match(f.queries[1],/FROM tbl_live_queue_sessions/);
});
test('exhausted deadlock retries preserve the due job and do not broadcast',async()=>{
    const f=recovery({failures:10});await assert.rejects(f.run(),{code:'ER_LOCK_DEADLOCK'});
    assert.deepEqual(f.state(),{due:true,called:0,attempts:3,commits:0,releases:3});
    assert.equal(f.emits.length,0);assert(!f.queries.some(q=>q.startsWith('UPDATE')));
});
test('lock timeout retries whole transaction; unexpected errors are not retried or cleared',async()=>{
    const timeout=recovery({code:'ER_LOCK_WAIT_TIMEOUT'});await timeout.run();assert.equal(timeout.state().attempts,2);
    const bad=recovery({code:'ER_BAD_FIELD_ERROR'});await assert.rejects(bad.run(),{code:'ER_BAD_FIELD_ERROR'});
    assert.equal(bad.state().attempts,1);assert.equal(bad.state().due,true);assert.equal(bad.emits.length,0);
});
test('a later worker poll can recover the preserved job after retries were exhausted',async()=>{
    const f=recovery({failures:3});await assert.rejects(f.run(),{code:'ER_LOCK_DEADLOCK'});
    assert.equal(f.state().due,true);
    await f.run();assert.equal(f.state().due,false);assert.equal(f.state().called,1);assert.equal(f.emits.length,1);
});
test('normal no-ready-patient outcome clears due schedule without calling a patient',async()=>{
    const f=recovery({businessError:true});assert.equal(await f.run(),null);
    assert.equal(f.state().due,false);assert.equal(f.state().attempts,1);assert.equal(f.emits.length,0);
});
test('transaction retry stays opt-in for unrelated modules',async()=>{
    const f=recovery();let attempts=0;
    await assert.rejects(f.withTransaction(async()=>{attempts++;throw Object.assign(Error('deadlock'),{code:'ER_LOCK_DEADLOCK'});}),{code:'ER_LOCK_DEADLOCK'});
    assert.equal(attempts,1);
});
test('retry attempts are bounded even if callers request a large retry count',async()=>{
    const f=recovery({failures:50,options:{maxRetries:1000}});
    await assert.rejects(f.run());assert.equal(f.state().attempts,4);
});
