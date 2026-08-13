const test = require('node:test');
const assert = require('node:assert/strict');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-ops-secret-at-least-16-characters';
process.env.DB_HOST = process.env.DB_HOST || '127.0.0.1';
process.env.DB_USER = process.env.DB_USER || 'test_user';
process.env.DB_NAME = process.env.DB_NAME || 'test_db';
process.env.NODE_ENV = 'test';

const { env } = require('../config/env');
const { requireOpsFeature, authorizeOpsUser } = require('../middleware/opsAccessMiddleware');
const { assertAllowedQuery } = require('../controllers/sqlPanelController');

const runMiddleware = (middleware, req = {}) => new Promise((resolve) => {
    const headers = {};
    const res = {
        setHeader: (name, value) => {
            headers[name] = value;
        },
    };

    middleware(req, res, (error) => resolve({ error, headers }));
});

test('disabled operations feature stays hidden behind 404', async () => {
    const original = env.ops.enableBackendLogViewer;
    env.ops.enableBackendLogViewer = false;

    try {
        const { error } = await runMiddleware(requireOpsFeature('enableBackendLogViewer'));
        assert.equal(error.statusCode, 404);
    } finally {
        env.ops.enableBackendLogViewer = original;
    }
});

test('enabled operations feature sends no-store response header', async () => {
    const original = env.ops.enableBackendLogViewer;
    env.ops.enableBackendLogViewer = true;

    try {
        const { error, headers } = await runMiddleware(requireOpsFeature('enableBackendLogViewer'));
        assert.equal(error, undefined);
        assert.equal(headers['Cache-Control'], 'no-store');
    } finally {
        env.ops.enableBackendLogViewer = original;
    }
});

test('operations access requires an allowlisted authenticated UUID', async () => {
    const original = env.ops.allowedUserUuids;
    env.ops.allowedUserUuids = ['allowed-uuid'];

    try {
        const denied = await runMiddleware(authorizeOpsUser, { user: { uuid: 'other-uuid' } });
        const allowed = await runMiddleware(authorizeOpsUser, { user: { uuid: 'ALLOWED-UUID' } });
        assert.equal(denied.error.statusCode, 403);
        assert.equal(allowed.error, undefined);
    } finally {
        env.ops.allowedUserUuids = original;
    }
});

test('production SQL policy is always read-only', () => {
    assert.equal(assertAllowedQuery('SELECT 1'), 'SELECT 1');
    assert.equal(assertAllowedQuery('SHOW TABLES'), 'SHOW TABLES');
    assert.throws(() => assertAllowedQuery('UPDATE master_users SET is_active = 0'), /Only these queries/);
    assert.throws(() => assertAllowedQuery('ALTER TABLE master_users ADD COLUMN unsafe INT'), /Only these queries/);
    assert.throws(() => assertAllowedQuery('DELETE FROM master_users'), /Only these queries/);
    assert.throws(() => assertAllowedQuery("SELECT * FROM master_users INTO OUTFILE '/tmp/users.csv'"), /file access/);
    assert.throws(() => assertAllowedQuery("SELECT 1 INTO/**/OUTFILE '/tmp/users.csv'"), /file access/);
    assert.throws(() => assertAllowedQuery("SELECT LOAD_FILE('/etc/passwd')"), /file access/);
    assert.throws(() => assertAllowedQuery("SELECT LOAD_FILE/**/('/etc/passwd')"), /file access/);
    assert.throws(() => assertAllowedQuery('EXPLAIN ANALYZE SELECT 1'), /file access/);
});
