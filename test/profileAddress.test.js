const test=require('node:test');
const assert=require('node:assert/strict');
const {buildProfileAddressUpdate}=require('../utils/profileAddress');
const existing={area_name:'Mowa',city:'Raipur',pincode:'492001',ward_no:'4',vidhan_sabha:'Raipur North',address:'Mowa, Ward 4, Raipur North, 492001, Raipur'};
test('state trims, persists in full address, preserves on omission and clears explicitly', () => {
    const updated = buildProfileAddressUpdate({ state_name: ' Chhattisgarh ' }, existing);
    assert.equal(updated.state_name, 'Chhattisgarh');
    assert.equal(updated.address, `${existing.address}, Chhattisgarh`);
    const saved = { ...existing, ...updated };
    assert.equal(buildProfileAddressUpdate({ city: 'Bhilai' }, saved).address, 'Mowa, Ward 4, Raipur North, 492001, Bhilai, Chhattisgarh');
    assert.equal(buildProfileAddressUpdate({ state_name: '' }, saved).address, existing.address);
    assert.equal(buildProfileAddressUpdate({ state_name: null }, saved).state_name, null);
    assert.equal(buildProfileAddressUpdate({ city: 'Raipur' }, { ...saved, area_name: null }).area_name, 'Mowa');
    for (const state_name of [123, {}, [], 'x'.repeat(101)]) {
        assert.throws(() => buildProfileAddressUpdate({ state_name }, existing), { statusCode: 400 });
    }
});
test('structured profile address updates derive full address and preserve ward / assembly',()=>{
    assert.deepEqual(buildProfileAddressUpdate({area_name:'  Shankar Nagar ',city:' Raipur ',pincode:'492007',address:'ignored'},existing),{area_name:'Shankar Nagar',city:'Raipur',pincode:'492007',address:'Shankar Nagar, Ward 4, Raipur North, 492007, Raipur'});
});
test('only city is mandatory; area and pincode can be explicitly cleared',()=>{
    assert.deepEqual(buildProfileAddressUpdate({area_name:'',city:'Raipur',pincode:null},{}),{area_name:null,city:'Raipur',pincode:null,address:'Raipur'});
    for(const body of [{city:''},{city:'Raipur',pincode:'4920'},{city:'Raipur',pincode:'49200A'},{city:'x'.repeat(101)},{city:'Raipur',area_name:'x'.repeat(151)},{city:{name:'Raipur'}}]) assert.throws(()=>buildProfileAddressUpdate(body,{}),{statusCode:400});
});
test('partial updates retain existing structured details without duplicating the known legacy suffix',()=>{
    assert.equal(buildProfileAddressUpdate({city:'Bhilai'},existing).address,'Mowa, Ward 4, Raipur North, 492001, Bhilai');
    assert.equal(buildProfileAddressUpdate({city:'Bhilai'},{...existing,area_name:null}).address,'Mowa, Ward 4, Raipur North, 492001, Bhilai');
    assert.equal(buildProfileAddressUpdate({city:'Raipur'},{address:'House 42, Near Mandir'}).area_name,'House 42, Near Mandir');
});
test('legacy address-only and unrelated profile updates remain compatible',()=>{
    assert.equal(buildProfileAddressUpdate({address:'Legacy text'},existing),null);
    assert.equal(buildProfileAddressUpdate({full_name:'Updated Name'},existing),null);
});

test('ward and assembly can change independently, clear explicitly, and preserve other address parts',()=>{
    const updated=buildProfileAddressUpdate({ward_no:' 12 ',vidhan_sabha:' Raipur West '},existing);
    assert.equal(updated.ward_no,'12');assert.equal(updated.vidhan_sabha,'Raipur West');
    assert.equal(updated.address,'Mowa, Ward 12, Raipur West, 492001, Raipur');
    assert.equal(buildProfileAddressUpdate({ward_no:'',vidhan_sabha:null},existing).address,'Mowa, 492001, Raipur');
    for(const body of [{ward_no:'x'.repeat(51)},{vidhan_sabha:'x'.repeat(151)},{ward_no:[]},{vidhan_sabha:{}}]) assert.throws(()=>buildProfileAddressUpdate(body,existing),{statusCode:400});
});
