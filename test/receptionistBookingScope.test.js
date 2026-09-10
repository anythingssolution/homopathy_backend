const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function routeGuards(method, route) {
    const layers = [];
    const router = { use: (...handlers) => layers.push({ handlers }) };
    for (const verb of ['get', 'post', 'put', 'patch']) {
        router[verb] = (url, ...handlers) => layers.push({ verb, url, handlers });
    }
    const middleware = {
        authenticate: 'authentication',
        authorizeRolesOrModuleAccess: () => 'reception-access',
        enforceSelectedBranchScope: 'selected-branch',
        authorizeAppointmentBranchScope: 'appointment-branch',
        authorizeConsultationBranchScope: 'consultation-branch',
    };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../routes/v1/receptionistRoutes.js'), 'utf8'), {
        module: { exports: {} },
        require: (name) => name === 'express' ? { Router: () => router }
            : name.includes('authMiddleware') ? middleware
                : new Proxy({}, { get: (_, key) => key }),
    });
    const guards = [];
    for (const layer of layers) {
        if (!layer.verb) guards.push(...layer.handlers);
        else if (layer.verb === method && layer.url === route) return [...guards, ...layer.handlers];
    }
    throw new Error('Missing route');
}

test('cross-branch booking requires authenticated reception access without restricting target to working branch', () => {
    for (const [method, route] of [['post', '/book-appointment'], ['get', '/booking-form-data'], ['get', '/booking-patients'], ['get', '/token-plate']]) {
        const guards = routeGuards(method, route);
        assert.deepEqual(guards.slice(0, 2), ['authentication', 'reception-access']);
        assert.ok(!guards.includes('selected-branch'));
    }
});

test('operational lists and appointment mutations retain branch restrictions', () => {
    for (const [method, route] of [['get', '/appointments'], ['get', '/patients'], ['get', '/form-data'], ['post', '/appointments/:appointment_id/approve']]) {
        assert.ok(routeGuards(method, route).includes('selected-branch'));
    }
    assert.ok(routeGuards('post', '/appointments/:appointment_id/approve').includes('appointment-branch'));
});
