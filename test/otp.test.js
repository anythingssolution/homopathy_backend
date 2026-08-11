const test = require('node:test');
const assert = require('node:assert/strict');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-otp-secret-at-least-16-characters';
process.env.DB_HOST = process.env.DB_HOST || '127.0.0.1';
process.env.DB_USER = process.env.DB_USER || 'test_user';
process.env.DB_NAME = process.env.DB_NAME || 'test_db';
process.env.NODE_ENV = 'test';
process.env.DEFAULT_OTP = '123456';
process.env.USE_DEFAULT_OTP_IN_PRODUCTION = 'false';

const { getBooleanEnv, validateOtpValue } = require('../config/env');
const { generateOtp } = require('../utils/otp');

test('non-production always uses the configured default OTP', () => {
    const otp = generateOtp({
        nodeEnv: 'development',
        defaultOtp: '246810',
        useDefaultInProduction: false,
        randomIntFn: () => {
            throw new Error('random generator must not run outside production');
        },
    });

    assert.equal(otp, '246810');
});

test('production uses the configured default OTP when the toggle is true', () => {
    const otp = generateOtp({
        nodeEnv: 'production',
        defaultOtp: '135790',
        useDefaultInProduction: true,
        randomIntFn: () => {
            throw new Error('random generator must not run when the production toggle is enabled');
        },
    });

    assert.equal(otp, '135790');
});

test('production generates a random six-digit OTP when the toggle is false', () => {
    let requestedRange = null;
    const otp = generateOtp({
        nodeEnv: 'production',
        defaultOtp: '123456',
        useDefaultInProduction: false,
        randomIntFn: (minimum, maximum) => {
            requestedRange = [minimum, maximum];
            return 654321;
        },
    });

    assert.equal(otp, '654321');
    assert.deepEqual(requestedRange, [100000, 1000000]);
    assert.match(otp, /^\d{6}$/);
});

test('boolean environment values accept only true or false', (t) => {
    const key = 'TEST_OTP_BOOLEAN_VALUE';
    const originalValue = process.env[key];

    t.after(() => {
        if (originalValue === undefined) {
            delete process.env[key];
        } else {
            process.env[key] = originalValue;
        }
    });

    process.env[key] = 'TRUE';
    assert.equal(getBooleanEnv(key, false), true);

    process.env[key] = 'false';
    assert.equal(getBooleanEnv(key, true), false);

    process.env[key] = '1';
    assert.throws(() => getBooleanEnv(key, false), /must be either true or false/);

    delete process.env[key];
    assert.equal(getBooleanEnv(key, false), false);
});

test('default OTP configuration must contain exactly six digits', () => {
    assert.equal(validateOtpValue('DEFAULT_OTP', ' 123456 '), '123456');
    assert.throws(() => validateOtpValue('DEFAULT_OTP', '12345'), /must be exactly 6 digits/);
    assert.throws(() => validateOtpValue('DEFAULT_OTP', '12345a'), /must be exactly 6 digits/);
});
