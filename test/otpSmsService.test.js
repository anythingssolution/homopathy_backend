const test = require('node:test');
const assert = require('node:assert/strict');
const { createOtpSmsSender, normalizeSmsMobile } = require('../services/otpSmsService');

const config = { provider: '2factor', apiKey: 'test-secret-key', templateName: 'DTH_OTP', requestTimeoutMs: 1000 };
const logger = { info() {}, warn() {} };
const makeSender = (fetchFn, overrides = {}) => createOtpSmsSender({ config, nodeEnv: 'development', logger, fetchFn, ...overrides });

test('sends the existing six-digit OTP using the approved custom template', async () => {
    const send = makeSender(async (url, options) => {
        assert.equal(decodeURIComponent(url), 'https://2factor.in/API/V1/test-secret-key/SMS/+919999999999/654321/DTH_OTP');
        assert.equal(options.method, 'GET');
        assert.equal(options.redirect, 'error');
        assert.ok(options.signal);
        return { ok: true, json: async () => ({ Status: 'Success', Details: 'request-id' }) };
    });
    assert.deepEqual(await send('9999999999', '654321'), { provider: '2factor', status: 'accepted', requestId: 'request-id' });
});

test('country code is added once and malformed mobile numbers are rejected', () => {
    assert.equal(normalizeSmsMobile('9999999999'), '+919999999999');
    assert.equal(normalizeSmsMobile('919999999999'), '+919999999999');
    assert.equal(normalizeSmsMobile('+919999999999'), '+919999999999');
    assert.throws(() => normalizeSmsMobile('999999abc9'), /Invalid mobile/);
});

test('provider HTTP, application and malformed-response failures do not become success', async () => {
    const responses = [
        { ok: false, status: 401 },
        { ok: true, json: async () => ({ Status: 'Error', Details: 'Invalid API key' }) },
        { ok: true, json: async () => ({ Status: 'Success' }) },
        { ok: true, json: async () => { throw new Error('Invalid JSON with secret'); } },
    ];
    for (const response of responses) {
        await assert.rejects(makeSender(async () => response)('9999999999', '654321'), (error) => {
            assert.equal(error.statusCode, 503);
            assert.equal(error.message, 'Unable to send OTP right now. Please try again shortly.');
            return true;
        });
    }
});

test('transport errors never expose the API key, number or OTP in logs or errors', async () => {
    const logs = [];
    const send = makeSender(async (url) => { throw new Error(`Request failed: ${url}`); }, {
        logger: { info: (value) => logs.push(value), warn: (value) => logs.push(value) },
    });
    await assert.rejects(send('9999999999', '654321'), (error) => {
        const output = `${error.stack} ${JSON.stringify(logs)}`;
        for (const secret of ['test-secret-key', '9999999999', '654321']) assert.ok(!output.includes(secret));
        return true;
    });
});

test('slow provider requests abort instead of hanging the login request', async () => {
    const send = makeSender((_url, { signal }) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('timeout')), { once: true });
    }), { config: { ...config, requestTimeoutMs: 10 } });
    await assert.rejects(send('9999999999', '654321'), { statusCode: 503 });
});

test('mock is local-only and missing credentials fail without sending', async () => {
    const fetchFn = () => { throw new Error('No network request expected'); };
    const local = makeSender(fetchFn, { config: { provider: 'mock' } });
    assert.equal((await local('9999999999', '654321')).status, 'mock');
    await assert.rejects(makeSender(fetchFn, { config: { provider: 'mock' }, nodeEnv: 'production' })('9999999999', '654321'), { statusCode: 503 });
    await assert.rejects(makeSender(fetchFn, { config: { ...config, apiKey: null } })('9999999999', '654321'), { statusCode: 503 });
});
