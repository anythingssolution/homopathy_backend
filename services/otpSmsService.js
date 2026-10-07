const AppError = require('../utils/AppError');

const normalizeSmsMobile = (mobileNo) => {
    const digits = String(mobileNo || '').trim().replace(/^\+/, '');
    if (!/^\d{10,15}$/.test(digits)) {
        throw new AppError('Invalid mobile number for OTP delivery', 400);
    }
    return `+${digits.length === 10 ? `91${digits}` : digits}`;
};

const createOtpSmsSender = ({ config, nodeEnv, fetchFn = globalThis.fetch, logger = console }) => async (mobileNo, otp) => {
    if (config.provider === 'mock') {
        if (nodeEnv === 'production') {
            throw new AppError('SMS OTP service is not configured. Please contact the clinic.', 503);
        }
        logger.info('[otp-sms] Mock delivery; no SMS sent');
        return { provider: 'mock', status: 'mock' };
    }
    if (config.provider !== '2factor' || !config.apiKey || !config.templateName) {
        throw new AppError('SMS OTP service is not configured. Please contact the clinic.', 503);
    }
    const recipient = normalizeSmsMobile(mobileNo);
    if (!/^\d{6}$/.test(String(otp))) {
        throw new AppError('Unable to generate verification OTP', 500);
    }
    // 2Factor's documented custom-OTP endpoint embeds secrets in the path.
    // Never log the URL, raw response, or underlying transport exception.
    const url = `https://2factor.in/API/V1/${encodeURIComponent(config.apiKey)}/SMS/${encodeURIComponent(recipient)}/${encodeURIComponent(otp)}/${encodeURIComponent(config.templateName)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.requestTimeoutMs);
    try {
        const response = await fetchFn(url, { method: 'GET', signal: controller.signal, redirect: 'error' });
        if (!response.ok) {
            logger.warn(`[otp-sms] 2Factor rejected request (HTTP ${response.status})`);
            throw new Error('Provider request rejected');
        }
        const payload = await response.json();
        if (payload?.Status !== 'Success' || typeof payload.Details !== 'string' || !payload.Details.trim()) {
            logger.warn('[otp-sms] 2Factor did not accept OTP request');
            throw new Error('Invalid provider response');
        }
        logger.info('[otp-sms] 2Factor accepted OTP request');
        return { provider: '2factor', status: 'accepted', requestId: payload.Details };
    } catch {
        throw new AppError('Unable to send OTP right now. Please try again shortly.', 503);
    } finally {
        clearTimeout(timer);
    }
};

module.exports = { createOtpSmsSender, normalizeSmsMobile };
