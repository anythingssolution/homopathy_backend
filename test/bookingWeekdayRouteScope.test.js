const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
test('only the doctor weekday matrix is independent of working branch; existing doctor routes retain scope', () => {
    const layers=[];
    const router={use:(...handlers)=>layers.push({handlers})};
    for(const verb of ['get','post','put','patch','delete']) router[verb]=(url,...handlers)=>layers.push({verb,url,handlers});
    const middleware={authenticate:'authenticated',authorizeRoles:role=>`role:${role}`,enforceSelectedBranchScope:'working-branch',authorizeAppointmentBranchScope:'appointment-branch',authorizeConsultationBranchScope:'consultation-branch'};
    vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../routes/v1/doctorRoutes.js'),'utf8'),{module:{exports:{}},require:name=>name==='express'?{Router:()=>router}:name.includes('authMiddleware')?middleware:new Proxy({},{get:(_,key)=>key})});
    const guards=(verb,url)=>{const active=[];for(const layer of layers){if(!layer.verb)active.push(...layer.handlers);else if(layer.verb===verb&&layer.url===url)return [...active,...layer.handlers];}throw new Error('Missing route');};
    for(const verb of ['get','put']) {
        const found=guards(verb,'/booking-weekdays');
        assert.ok(found.includes('authenticated'));assert.ok(found.includes('role:doctor'));assert.ok(!found.includes('working-branch'));
    }
    for(const [verb,url] of [['get','/dashboard'],['get','/schedule-rules'],['post','/leaves'],['get','/consultations/:appointment_id']]) assert.ok(guards(verb,url).includes('working-branch'));
});
