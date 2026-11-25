const test = require('node:test');
const assert = require('node:assert/strict');
process.env.JWT_SECRET ||= 'test-product-sort-secret'; process.env.DB_HOST ||= 'localhost'; process.env.DB_USER ||= 'test'; process.env.DB_NAME ||= 'test';
const db = require('../config/db');
const calls=[];
db.query=async(sql,params)=>{calls.push({sql,params});return sql.includes('COUNT(*)')?[{total:45}]:[];};
const {listMedicalProducts}=require('../services/medicalProductMasterService');
test('all sortable product fields use whitelist ordering before global pagination and preserve filters',async()=>{
    for(const sortBy of ['product','source','variant','price','status','created_at'])for(const sortOrder of ['asc','desc']){
        calls.length=0;
        await listMedicalProducts({page:2,limit:20,search:'DROP',status:'active',sourceType:'DOCTOR_MANUAL',sortBy,sortOrder});
        assert.match(calls[1].sql,new RegExp(`ORDER BY[\\s\\S]+ ${sortOrder.toUpperCase()}[\\s\\S]+LIMIT \\? OFFSET \\?`));
        assert.match(calls[1].sql,/mmp.is_active = 1/);
        assert.deepEqual(calls[1].params,['%DROP%','%DROP%','%DROP%','%DROP%','DOCTOR_MANUAL',20,20]);
    }
});
test('unsafe sort is rejected and default product order stays unchanged',async()=>{
    calls.length=0;
    await assert.rejects(listMedicalProducts({sortBy:'id; DROP TABLE anything'}),e=>e.statusCode===400);
    await assert.rejects(listMedicalProducts({sortOrder:'desc;--'}),e=>e.statusCode===400);
    assert.equal(calls.length,0);
    await listMedicalProducts({});
    assert.match(calls[1].sql,/ORDER BY \(TRIM\(mmp.product_name\) REGEXP '\^\[0-9\]'\) ASC, mmp.product_name ASC, mmp.id ASC/);
});
