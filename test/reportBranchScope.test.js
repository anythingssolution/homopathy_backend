const test = require('node:test');
const assert = require('node:assert/strict');
for (const key of ['JWT_SECRET', 'DB_HOST', 'DB_USER', 'DB_NAME']) process.env[key] ||= 'report-scope-test';

const load = (t, branches) => {
    const db = require.resolve('../config/db'), middleware = require.resolve('../middleware/reportBranchScope');
    const before = require.cache[db], previous = require.cache[middleware];
    const calls = [];
    require.cache[db] = { id: db, filename: db, loaded: true, exports: { query: async (sql, params) => {
        calls.push({ sql, params });
        return sql.includes('has_access') ? branches : [{ fk_branch_id: 2 }];
    } } };
    delete require.cache[middleware];
    t.after(() => { if (before) require.cache[db] = before; else delete require.cache[db]; if (previous) require.cache[middleware] = previous; else delete require.cache[middleware]; });
    return { ...require(middleware), calls };
};
const request = (query = {}, selected = 1) => ({ query, body: {}, user: { id: 10, role: 'doctor', role_code: 'DOC', selected_branch_id: selected } });
const invoke = async (fn, req) => { let error; await fn(req, {}, value => { error = value; }); return error; };
const branches = [{ id: 1, branch_name: 'Lily', has_access: 1 }, { id: 2, branch_name: 'Devendra', has_access: 1 }, { id: 3, branch_name: 'Other', has_access: 0 }];

test('independent default combines only assigned active branches without reading or saving the working selection', async t => {
    const { enforceReportBranchScope, calls } = load(t, branches);
    const req = request({ report_scope: 'independent' }, null);
    assert.equal(await invoke(enforceReportBranchScope, req), undefined);
    assert.deepEqual(req.reportScope.branchIds, [1, 2]);
    assert.equal(req.reportScope.branchId, null);
    assert.equal(req.reportScope.allClinicBranches, false);
    assert.equal(req.user.selected_branch_id, null);
    assert.equal(req.selectedBranchId, undefined);
    assert.equal(req.query.branch_id, undefined);
    assert.deepEqual(calls[0].params, [10]);
    assert.doesNotMatch(calls[0].sql, /UPDATE|INSERT|DELETE/);
});

test('reports can select another authorized branch while operational branch remains unchanged', async t => {
    const { enforceReportBranchScope } = load(t, branches);
    const req = request({ report_scope: 'independent', branch_id: '2' });
    assert.equal(await invoke(enforceReportBranchScope, req), undefined);
    assert.deepEqual(req.reportScope.branchIds, [2]);
    assert.equal(req.user.selected_branch_id, 1);
    assert.equal(req.selectedBranchId, undefined);
});

test('unassigned/inactive branch IDs, malformed input and empty access cannot become unrestricted reports', async t => {
    const { enforceReportBranchScope } = load(t, branches);
    for (const value of ['3', '999', '-1', '0', '', 'NaN', ['1', '2'], '1 OR 1=1']) {
        const error = await invoke(enforceReportBranchScope, request({ report_scope: 'independent', branch_id: value }));
        assert.ok(error, String(value));
        assert.ok([400, 403].includes(error.statusCode));
    }
});

test('all branches registration scope is unrestricted only when the user has every active branch', async t => {
    const { enforceReportBranchScope } = load(t, branches.slice(0, 2));
    const all = request({ report_scope: 'independent', branch_id: 'all' });
    await invoke(enforceReportBranchScope, all);
    assert.equal(all.reportScope.allClinicBranches, true);
    const one = request({ report_scope: 'independent', branch_id: '1' });
    await invoke(enforceReportBranchScope, one);
    assert.equal(one.reportScope.allClinicBranches, false);
});

test('no branch access is rejected even for an All Branches request', async t => {
    const { enforceReportBranchScope } = load(t, branches.map(b => ({ ...b, has_access: 0 })));
    assert.equal((await invoke(enforceReportBranchScope, request({ report_scope: 'independent', branch_id: 'all' }))).statusCode, 403);
});

test('legacy Bills Next/report consumers still require and enforce the operational selected branch', async t => {
    const { enforceReportBranchScope, calls } = load(t, branches);
    const req = request();
    assert.equal(await invoke(enforceReportBranchScope, req), undefined);
    assert.equal(req.query.branch_id, '1');
    assert.equal(req.selectedBranchId, 1);
    assert.equal(req.reportScope, undefined);
    assert.equal(calls.length, 0);
    assert.equal((await invoke(enforceReportBranchScope, request({ branch_id: '2' }))).statusCode, 403);
    assert.equal((await invoke(enforceReportBranchScope, request({}, null))).statusCode, 409);
    assert.equal((await invoke(enforceReportBranchScope, request({ branch_id: 'all' }))).statusCode, 400);
});

test('read-only report entity drilldowns authorize the entity itself before using its branch', async t => {
    const { authorizeReportEntity } = load(t, branches);
    const req = request(); req.params = { appointment_id: '20' }; req.reportScope = { branchIds: [1, 2] };
    assert.equal(await invoke(authorizeReportEntity('appointment'), req), undefined);
    assert.equal(req.selectedBranchId, 2);
    assert.equal(req.user.selected_branch_id, 1);
    req.reportScope.branchIds = [1];
    assert.equal((await invoke(authorizeReportEntity('appointment'), req)).statusCode, 403);
});
