const rateLimit = require('express-rate-limit');
const { env } = require('../config/env');

const buildRateLimiter = ({ windowMs, max, message }) => rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
        success: false,
        message,
    },
});

const authRateLimiter = buildRateLimiter({
    windowMs: env.rateLimit.authWindowMs,
    max: env.rateLimit.authMaxRequests,
    message: 'Too many authentication attempts. Please try again later.',
});

const otpRateLimiter = buildRateLimiter({
    windowMs: env.rateLimit.otpWindowMs,
    max: env.rateLimit.otpMaxRequests,
    message: 'Too many OTP requests. Please wait before trying again.',
});

module.exports = {
    authRateLimiter,
    otpRateLimiter,
};
