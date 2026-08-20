const crypto = require('crypto');
const { env } = require('../config/env');
const WhatsAppProviderFactory = require('../services/whatsapp/WhatsAppProviderFactory');

const isWhatsAppConfigured = () => {
    // In mock mode, we are always ready to simulate
    if (WhatsAppProviderFactory.isMockMode()) {
        return true;
    }
    return Boolean(env.whatsapp.accessToken && env.whatsapp.phoneNumberId);
};

const normalizeWhatsAppRecipient = (mobileNo) => {
    const digits = String(mobileNo || '').replace(/\D/g, '');
    if (!digits) {
        throw new Error('A valid mobile number is required to send WhatsApp messages');
    }
    if (digits.length === 10 && env.whatsapp.defaultCountryCode) {
        return `${env.whatsapp.defaultCountryCode}${digits}`;
    }
    return digits;
};

const sendWhatsAppTextMessage = async (options) => {
    const provider = WhatsAppProviderFactory.getProvider();
    return provider.sendTextMessage(options);
};

const sendWhatsAppTemplateMessage = async (options) => {
    const provider = WhatsAppProviderFactory.getProvider();
    return provider.sendTemplateMessage(options);
};

const sendWhatsAppDocumentMessage = async (options) => {
    const provider = WhatsAppProviderFactory.getProvider();
    return provider.sendDocumentMessage(options);
};

const sendRegistrationWelcomeWhatsApp = async ({ mobileNo, patientId = null, createdBy = null }) => sendWhatsAppTextMessage({
    mobileNo,
    message: env.whatsapp.welcomeMessage || 'Welcome to Dr Trivedi Homeopathy Clinic',
    patientId,
    createdBy,
});

const verifyMetaWebhookSignature = (rawBody, signatureHeader) => {
    if (!signatureHeader || !env.whatsapp.appSecret) {
        return false;
    }

    const [algorithm, signature] = signatureHeader.split('=');
    if (algorithm !== 'sha256' || !signature) {
        return false;
    }

    const hmac = crypto.createHmac('sha256', env.whatsapp.appSecret);
    const expectedSignature = hmac.update(rawBody).digest('hex');

    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature));
};

module.exports = {
    isWhatsAppConfigured,
    normalizeWhatsAppRecipient,
    sendWhatsAppTextMessage,
    sendWhatsAppTemplateMessage,
    sendWhatsAppDocumentMessage,
    sendRegistrationWelcomeWhatsApp,
    verifyMetaWebhookSignature,
};
