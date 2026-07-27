const http = require('http');
const https = require('https');
const { env } = require('../config/env');

const isWhatsAppConfigured = () => Boolean(
    env.whatsapp.accessToken
    && env.whatsapp.phoneNumberId
);

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

const postJson = (urlString, payload, headers = {}, timeoutMs = 10000) => new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const transport = url.protocol === 'http:' ? http : https;
    const body = JSON.stringify(payload);

    const request = transport.request(
        {
            protocol: url.protocol,
            hostname: url.hostname,
            port: url.port || undefined,
            path: `${url.pathname}${url.search}`,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body),
                ...headers,
            },
            timeout: timeoutMs,
        },
        (response) => {
            let rawData = '';

            response.setEncoding('utf8');
            response.on('data', (chunk) => {
                rawData += chunk;
            });
            response.on('end', () => {
                let parsedBody = rawData;

                if (rawData) {
                    try {
                        parsedBody = JSON.parse(rawData);
                    } catch (error) {
                        parsedBody = rawData;
                    }
                }

                if (response.statusCode >= 200 && response.statusCode < 300) {
                    resolve(parsedBody);
                    return;
                }

                reject(new Error(
                    `WhatsApp API request failed with status ${response.statusCode}: ${rawData || 'empty response'}`
                ));
            });
        }
    );

    request.on('timeout', () => {
        request.destroy(new Error(`WhatsApp API request timed out after ${timeoutMs}ms`));
    });

    request.on('error', reject);
    request.write(body);
    request.end();
});

const sendWhatsAppTextMessage = async ({ mobileNo, message }) => {
    if (!isWhatsAppConfigured()) {
        return {
            skipped: true,
            reason: 'missing_configuration',
        };
    }

    const to = normalizeWhatsAppRecipient(mobileNo);
    const response = await postJson(
        `https://graph.facebook.com/${env.whatsapp.apiVersion}/${env.whatsapp.phoneNumberId}/messages`,
        {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to,
            type: 'text',
            text: {
                preview_url: false,
                body: String(message).trim(),
            },
        },
        {
            Authorization: `Bearer ${env.whatsapp.accessToken}`,
        },
        env.whatsapp.requestTimeoutMs
    );

    return {
        skipped: false,
        response,
    };
};

const sendRegistrationWelcomeWhatsApp = async ({ mobileNo }) => sendWhatsAppTextMessage({
    mobileNo,
    message: env.whatsapp.welcomeMessage,
});

module.exports = {
    sendWhatsAppTextMessage,
    sendRegistrationWelcomeWhatsApp,
};
