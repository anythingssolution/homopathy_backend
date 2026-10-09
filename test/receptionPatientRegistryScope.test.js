const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const express = require('express');
process.env.JWT_SECRET = 'registry-scope-test';
process.env.DB_HOST = '127.0.0.1';
process.env.DB_USER = 'test';
process.env.DB_NAME = 'test';
const { enforceSelectedBranchScope } = require('../middleware/authMiddleware');

function loadRouter() {
    const handler = (req, res) => res.json({ branch: req.query.branch_id || null, selected: req.selectedBranchId || null });
    const controllers = new Proxy({}, { get: () => handler });
    const module = { exports: {} };
    const source = fs.readFileSync(path.join(__dirname, '../routes/v1/receptionistRoutes.js'), 'utf8');
    vm.runInNewContext(source, {
        module,
        require: (name) => {
            if (name === 'express') return express;
            if (name.includes('authMiddleware')) return {
                authenticate: (req, _res, next) => req.user ? next() : next(Object.assign(new Error('Unauthenticated'), { statusCode: 401 })),
                authorizeRolesOrModuleAccess: () => (req, _res, next) => req.user.role === 'REC' ? next() : next(Object.assign(new Error('Forbidden'), { statusCode: 403 })),
                enforceSelectedBranchScope,
                authorizeAppointmentBranchScope: (_req, _res, next) => next(),
                authorizeConsultationBranchScope: (_req, _res, next) => next(),
            };
            return controllers;
        },
    });
    return module.exports;
}

function request(method, url, user = { role: 'REC', selected_branch_id: 1 }) {
    return new Promise((resolve, reject) => {
        loadRouter().handle({ method, url, query: {}, body: {}, user }, { json: resolve }, (error) => reject(error || new Error('Route not found')));
    });
}

test('shared patient list, editing, audit history and family creation do not inherit selected branch', async () => {
    for (const [method, url] of [['GET', '/patients'], ['PATCH', '/patients/10'], ['GET', '/patients/10/update-history'], ['POST', '/patients/10/family-members']]) {
        const result = await request(method, url);
        assert.equal(result.branch, null);
        assert.equal(result.selected, null);
    }
    assert.equal((await request('GET', '/patients', { role: 'REC' })).branch, null);
});

test('appointment operations and clinical history retain selected branch scope', async () => {
    for (const url of ['/appointments', '/patients/10', '/prescriptions']) {
        const result = await request('GET', url);
        assert.equal(result.branch, '1');
        assert.equal(result.selected, 1);
    }
    await assert.rejects(request('GET', '/appointments', { role: 'REC' }), (error) => error.statusCode === 409);
});

test('global registry routes still require authenticated reception access', async () => {
    await assert.rejects(request('GET', '/patients', null), (error) => error.statusCode === 401);
    await assert.rejects(request('GET', '/patients', { role: 'PAT' }), (error) => error.statusCode === 403);
});
