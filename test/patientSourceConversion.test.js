const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
require('dotenv').config();
test('source conversion preserves attribution, existing text and dates; rerun changes nothing', {skip:process.env.RUN_SOURCE_CONVERSION_DB_TEST!=='1'},async()=>{
    const mysql=require('mysql2/promise');
    const c=await mysql.createConnection({host:process.env.DB_HOST,port:process.env.DB_PORT,user:process.env.DB_USER,password:process.env.DB_PASSWORD,database:process.env.DB_NAME,dateStrings:true});
    try{
        await c.query('CREATE TEMPORARY TABLE tbl_patient_discovery_sources (subject_key VARCHAR(40) PRIMARY KEY,patient_id BIGINT,family_member_id BIGINT NULL,appointment_id BIGINT,source_code VARCHAR(30),other_detail VARCHAR(255),created_at TIMESTAMP)');
        await c.query("INSERT INTO tbl_patient_discovery_sources VALUES ('PAT:1',1,NULL,3,'NOT_KNOWN',NULL,'2026-11-17 11:00:00'),('FM:2',1,2,4,'NOT_KNOWN','Original note','2026-11-18 12:00:00'),('PAT:9',9,NULL,8,'OTHER','Poster','2026-11-19 13:00:00')");
        const [before]=await c.query('SELECT * FROM tbl_patient_discovery_sources ORDER BY subject_key');
        const sql=fs.readFileSync(path.join(__dirname,'../sql/migrations/2026-11-25_001_patient_source_unknown_to_other.sql'),'utf8');
        await c.query(sql);
        const [after]=await c.query('SELECT * FROM tbl_patient_discovery_sources ORDER BY subject_key');
        const expected=before.map(r=>r.source_code==='NOT_KNOWN'?{...r,source_code:'OTHER',other_detail:r.other_detail||'Patient does not know'}:r);
        assert.deepEqual(after,expected);
        const [again]=await c.query(sql);assert.equal(again.affectedRows,0);
    }finally{await c.end();}
});
