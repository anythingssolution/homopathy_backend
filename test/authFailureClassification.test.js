const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const AppError=require('../utils/AppError');
const source=fs.readFileSync(require.resolve('../middleware/authMiddleware'),'utf8');
const start=source.indexOf('const authenticate ='),end=source.indexOf('\nconst authorizeRoles',start);
function handler({jwtError,dbError}={}){
 return vm.runInNewContext(`${source.slice(start,end)}; authenticate`,{
  AppError,env:{jwtSecret:'test'},jwt:{verify:()=>{if(jwtError)throw jwtError;return {id:7};}},
  query:async()=>{if(dbError)throw dbError;return [];},
 });
}
test('expired/invalid tokens have a safe reason code and no raw token in diagnostics',async()=>{
 for(const [name,reason]of [['TokenExpiredError','ACCESS_EXPIRED'],['JsonWebTokenError','ACCESS_INVALID'],['NotBeforeError','ACCESS_NOT_ACTIVE']]){
  let result;await handler({jwtError:Object.assign(Error('sensitive detail'),{name})})({headers:{authorization:'Bearer secret-value'}},{},e=>{result=e;});
  assert.equal(result.statusCode,401);assert.equal(result.details.auth_reason,reason);
  assert(!JSON.stringify(result).includes('secret-value'));assert(!JSON.stringify(result).includes('sensitive detail'));
 }
});
test('database failure is preserved as server error instead of misreporting expired login',async()=>{
 const dbError=Object.assign(Error('Database unavailable'),{code:'ECONNREFUSED'});let result;
 await handler({dbError})({headers:{authorization:'Bearer test'}},{},e=>{result=e;});
 assert.equal(result,dbError);assert.notEqual(result.statusCode,401);
});
