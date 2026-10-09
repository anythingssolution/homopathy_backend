const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { resolveRepeatBillTests } = require('../services/repeatBillTests');
const { partitionMedicinePurchaseItems } = require('../utils/medicinePurchaseItems');

const masterConnection = { execute: async (_sql, ids) => [ids.filter(id => id !== 99).map(id => ({ id, test_name: 'CBC', amount: '250.00' }))] };
test('repeat tests use current master price and reject stale, duplicate or unavailable selections', async () => {
    assert.deepEqual(await resolveRepeatBillTests(masterConnection), []);
    assert.deepEqual(await resolveRepeatBillTests(masterConnection, [{ master_test_id: 1, amount: 250 }]), [{ master_test_id: 1, test_name: 'CBC', amount: 250 }]);
    await assert.rejects(resolveRepeatBillTests(masterConnection, [{ master_test_id: 1, amount: 1 }]), /price has changed/);
    await assert.rejects(resolveRepeatBillTests(masterConnection, [{ master_test_id: 1 }, { master_test_id: 1 }]), /twice/);
    await assert.rejects(resolveRepeatBillTests(masterConnection, [{ master_test_id: 99 }]), /no longer available/);
    await assert.rejects(resolveRepeatBillTests(masterConnection, [{ master_test_id: -1 }]), /valid test/);
});

test('purchase history separates tests from medicines and courier without changing old medicine rows', () => {
    const medicine = { item_type: 'MEDICATION', item_name: '14/6', amount: 100 };
    const result = partitionMedicinePurchaseItems([medicine, { id: 5, item_type: 'TEST', item_name: 'CBC', amount: 250 }, { item_type: 'DELIVERY', item_name: 'Courier Charge', amount: 50 }]);
    assert.deepEqual(result.medications, [medicine]);
    assert.equal(result.tests[0].test_name, 'CBC');
    assert.equal(result.tests[0].consultation_test_id, 'bill-test-5');
    assert.equal(result.tests[0].amount, 250);
    assert.equal(result.delivery.length, 1);
});

const loadBillService = () => {
    const source = fs.readFileSync(path.join(__dirname, '../services/billingService.js'), 'utf8');
    return vm.runInNewContext(source.slice(source.indexOf('const createRepeatMedicineBill ='), source.indexOf('\nmodule.exports =', source.indexOf('const createRepeatMedicineBill ='))) + '; createRepeatMedicineBill;', { AppError: Error, normalizeAmount: value => Number(Number(value).toFixed(2)), generateBillNumber: async () => 'BILL_TEST' });
};
for (const [label, prescribedItems, tests, expected] of [
    ['existing medicine-only', [{ amount: 100, medicine_value: '14/6', consultation_medication_id: 4 }], [], 100],
    ['medicine with new test', [{ amount: 100, medicine_value: '14/6', consultation_medication_id: 4 }], [{ test_name: 'CBC', amount: 250 }], 350],
    ['test-only', [], [{ test_name: 'CBC', amount: 250 }], 250],
]) test(`repeat bill ${label} keeps snapshot total and correct item types`, async () => {
    const writes = [];
    const connection = { execute: async (sql, params) => { writes.push({ sql, params }); return [{ insertId: 20 }]; } };
    await loadBillService()({ connection, patientId: 7, branchId: 1, sourceConsultationId: 2, prescribedItems, tests, createdByUserId: 1 });
    assert.equal(writes[0].params[4], expected);
    const testWrites = writes.filter(write => write.sql.includes("'TEST'"));
    assert.equal(testWrites.length, tests.length);
    if (tests.length) assert.deepEqual(Array.from(testWrites[0].params), [20, 'CBC', 250, 250]);
});
