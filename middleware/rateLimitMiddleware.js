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

// Global Rate Limiter for general APIs
const globalRateLimiter = buildRateLimiter({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 500, // limit each IP to 100 requests per windowMs
    message: 'Too many requests from this IP. Please try again after 15 minutes.',
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
    globalRateLimiter,
    authRateLimiter,
    otpRateLimiter,
};
