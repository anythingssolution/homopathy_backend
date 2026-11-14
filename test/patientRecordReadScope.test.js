const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function guardsFor(method, route) {
    const layers = [];
    const router = { use: (...handlers) => layers.push({ handlers }) };
    for (const method of ['get', 'post', 'delete']) router[method] = (route, ...handlers) => layers.push({ method, route, handlers });
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../routes/v1/patientRecordRoutes.js'), 'utf8'), {
        module: { exports: {} }, require: name => name === 'express' ? { Router: () => router }
            : name.includes('authMiddleware') ? { authenticate: 'auth', authorizeRolesOrModuleAccess: () => 'staff-only', enforceSelectedBranchScope: 'working-branch' }
                : new Proxy({}, { get: (_, key) => key }),
    });
    const guards = [];
    for (const layer of layers) {
        if (!layer.method) guards.push(...layer.handlers);
        else if (layer.method === method && layer.route === route) return [...guards, ...layer.handlers];
    }
    throw new Error('Missing route');
}
test('cross-branch record reads retain staff authentication and module authorization', () => {
    for (const route of ['/branches', '/patients', '/patients/:patient_id', '/patients/:patient_id/visits', '/patients/:patient_id/prescription-timeline']) {
        assert.deepEqual(guardsFor('get', route).slice(0, 2), ['auth', 'staff-only']);
        assert.ok(!guardsFor('get', route).includes('working-branch'));
    }
});
test('document writes and downloads retain their working-branch restrictions', () => {
    for (const [method, route] of [['post', '/documents'], ['delete', '/documents/:document_id'], ['post', '/documents/:document_id/archive'], ['get', '/documents/:document_id/download']]) {
        assert.ok(guardsFor(method, route).includes('working-branch'));
    }
});
