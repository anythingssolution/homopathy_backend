const test = require('node:test');
const assert = require('node:assert/strict');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-call-tune';
process.env.DB_HOST = process.env.DB_HOST || '127.0.0.1';
process.env.DB_USER = process.env.DB_USER || 'test';
process.env.DB_NAME = process.env.DB_NAME || 'test';

const { CALL_TUNE_MODES } = require('../services/callTuneService');

test('call tune modes stay limited so TV never gets an unknown value', () => {
    assert.deepEqual(CALL_TUNE_MODES, ['CHIME', 'TEMPLATE', 'CUSTOM']);
});
