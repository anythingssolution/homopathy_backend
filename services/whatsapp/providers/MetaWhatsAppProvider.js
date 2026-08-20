const http = require('http');
const https = require('https');
const WhatsAppProviderInterface = require('./WhatsAppProviderInterface');
const { env } = require('../../../config/env');
const { query } = require('../../../config/db');

class MetaWhatsAppProvider extends WhatsAppProviderInterface {
    getProviderName() {
        return 'META_CLOUD_API';
    }

    isConfigured() {
        return Boolean(env.whatsapp.accessToken && env.whatsapp.phoneNumberId);
    }

    normalizeRecipient(mobileNo) {
        const digits = String(mobileNo || '').replace(/\D/g, '');
        if (!digits) {
            throw new Error('A valid mobile number is required to send WhatsApp messages');
        }
        if (digits.length === 10 && env.whatsapp.defaultCountryCode) {
            return `${env.whatsapp.defaultCountryCode}${digits}`;
        }
        return digits;
    }

    postJson(urlString, payload, headers = {}, timeoutMs = 10000) {
        return new Promise((resolve, reject) => {
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
                            `WhatsApp API request failed with status ${response.statusCode}: ${typeof parsedBody === 'object' ? JSON.stringify(parsedBody) : (rawData || 'empty response')}`
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
    }

    async logMessage({
        patientId = null,
        doctorId = null,
        branchId = null,
        appointmentId = null,
        prescriptionId = null,
        billId = null,
        messageType = 'TEXT',
        templateName = null,
        recipientPhone,
        messageText = null,
        mediaUrl = null,
        providerMessageId = null,
        status = 'queued',
        errorCode = null,
        errorMessage = null,
        createdBy = null,
    }) {
        const result = await query(
            `INSERT INTO tbl_whatsapp_messages
             (fk_patient_id, fk_doctor_id, fk_branch_id, fk_appointment_id, fk_prescription_id,
              fk_bill_id, message_type, template_name, recipient_phone, message_text,
              media_url, provider_message_id, status, error_code, error_message,
              sent_at, created_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CASE WHEN ? = 'sent' THEN NOW() ELSE NULL END, ?)`,
            [
                patientId,
                doctorId,
                branchId,
                appointmentId,
                prescriptionId,
                billId,
                messageType,
                templateName,
                recipientPhone,
                messageText,
                mediaUrl,
                providerMessageId,
                status,
                errorCode,
                errorMessage,
                status,
                createdBy,
            ]
        );

        return {
            insertId: result?.insertId,
        };
    }

    async sendTextMessage({
        mobileNo,
        message,
        patientId = null,
        doctorId = null,
        branchId = null,
        appointmentId = null,
        createdBy = null,
    }) {
        const to = this.normalizeRecipient(mobileNo);

        if (!this.isConfigured()) {
            const logResult = await this.logMessage({
                patientId,
                doctorId,
                branchId,
                appointmentId,
                messageType: 'TEXT',
                recipientPhone: to,
                messageText: message,
                status: 'failed',
                errorCode: 'MISSING_CONFIG',
                errorMessage: 'WhatsApp credentials not configured on backend server',
                createdBy,
            });

            return {
                skipped: true,
                provider: 'META_CLOUD_API',
                reason: 'missing_configuration',
                messageId: logResult.insertId,
            };
        }

        let response;
        let status = 'sent';
        let providerMessageId = null;
        let errorCode = null;
        let errorMessage = null;

        try {
            response = await this.postJson(
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

            providerMessageId = response?.messages?.[0]?.id || null;
        } catch (err) {
            status = 'failed';
            errorCode = 'META_API_ERROR';
            errorMessage = err.message;
        }

        const logResult = await this.logMessage({
            patientId,
            doctorId,
            branchId,
            appointmentId,
            messageType: 'TEXT',
            recipientPhone: to,
            messageText: message,
            providerMessageId,
            status,
            errorCode,
            errorMessage,
            createdBy,
        });

        return {
            skipped: false,
            provider: 'META_CLOUD_API',
            response,
            status,
            providerMessageId,
            messageId: logResult.insertId,
        };
    }

    async sendTemplateMessage({
        mobileNo,
        templateName,
        languageCode = 'en',
        parameters = [],
        patientId = null,
        doctorId = null,
        branchId = null,
        appointmentId = null,
        createdBy = null,
    }) {
        const to = this.normalizeRecipient(mobileNo);

        const components = parameters.length > 0 ? [
            {
                type: 'body',
                parameters: parameters.map((param) => ({
                    type: 'text',
                    text: String(param),
                })),
            },
        ] : [];

        if (!this.isConfigured()) {
            const logResult = await this.logMessage({
                patientId,
                doctorId,
                branchId,
                appointmentId,
                messageType: 'TEMPLATE',
                templateName,
                recipientPhone: to,
                messageText: `Template: ${templateName} (${parameters.join(', ')})`,
                status: 'failed',
                errorCode: 'MISSING_CONFIG',
                errorMessage: 'WhatsApp credentials not configured on backend server',
                createdBy,
            });

            return {
                skipped: true,
                provider: 'META_CLOUD_API',
                reason: 'missing_configuration',
                messageId: logResult.insertId,
            };
        }

        let response;
        let status = 'sent';
        let providerMessageId = null;
        let errorCode = null;
        let errorMessage = null;

        try {
            response = await this.postJson(
                `https://graph.facebook.com/${env.whatsapp.apiVersion}/${env.whatsapp.phoneNumberId}/messages`,
                {
                    messaging_product: 'whatsapp',
                    recipient_type: 'individual',
                    to,
                    type: 'template',
                    template: {
                        name: templateName,
                        language: { code: languageCode },
                        ...(components.length > 0 ? { components } : {}),
                    },
                },
                {
                    Authorization: `Bearer ${env.whatsapp.accessToken}`,
                },
                env.whatsapp.requestTimeoutMs
            );

            providerMessageId = response?.messages?.[0]?.id || null;
        } catch (err) {
            status = 'failed';
            errorCode = 'META_TEMPLATE_ERROR';
            errorMessage = err.message;
        }

        const logResult = await this.logMessage({
            patientId,
            doctorId,
            branchId,
            appointmentId,
            messageType: 'TEMPLATE',
            templateName,
            recipientPhone: to,
            messageText: `Template: ${templateName} (${parameters.join(', ')})`,
            providerMessageId,
            status,
            errorCode,
            errorMessage,
            createdBy,
        });

        return {
            skipped: false,
            provider: 'META_CLOUD_API',
            response,
            status,
            providerMessageId,
            messageId: logResult.insertId,
        };
    }

    async sendDocumentMessage({
        mobileNo,
        documentUrl,
        filename,
        caption = '',
        patientId = null,
        doctorId = null,
        branchId = null,
        appointmentId = null,
        prescriptionId = null,
        billId = null,
        createdBy = null,
    }) {
        const to = this.normalizeRecipient(mobileNo);

        if (!this.isConfigured()) {
            const logResult = await this.logMessage({
                patientId,
                doctorId,
                branchId,
                appointmentId,
                prescriptionId,
                billId,
                messageType: 'DOCUMENT',
                recipientPhone: to,
                mediaUrl: documentUrl,
                messageText: caption || `Document: ${filename}`,
                status: 'failed',
                errorCode: 'MISSING_CONFIG',
                errorMessage: 'WhatsApp credentials not configured on backend server',
                createdBy,
            });

            return {
                skipped: true,
                provider: 'META_CLOUD_API',
                reason: 'missing_configuration',
                messageId: logResult.insertId,
            };
        }

        let response;
        let status = 'sent';
        let providerMessageId = null;
        let errorCode = null;
        let errorMessage = null;

        try {
            response = await this.postJson(
                `https://graph.facebook.com/${env.whatsapp.apiVersion}/${env.whatsapp.phoneNumberId}/messages`,
                {
                    messaging_product: 'whatsapp',
                    recipient_type: 'individual',
                    to,
                    type: 'document',
                    document: {
                        link: documentUrl,
                        filename,
                        ...(caption ? { caption } : {}),
                    },
                },
                {
                    Authorization: `Bearer ${env.whatsapp.accessToken}`,
                },
                env.whatsapp.requestTimeoutMs
            );

            providerMessageId = response?.messages?.[0]?.id || null;
        } catch (err) {
            status = 'failed';
            errorCode = 'META_DOCUMENT_ERROR';
            errorMessage = err.message;
        }

        const logResult = await this.logMessage({
            patientId,
            doctorId,
            branchId,
            appointmentId,
            prescriptionId,
            billId,
            messageType: 'DOCUMENT',
            recipientPhone: to,
            mediaUrl: documentUrl,
            messageText: caption || `Document: ${filename}`,
            providerMessageId,
            status,
            errorCode,
            errorMessage,
            createdBy,
        });

        return {
            skipped: false,
            provider: 'META_CLOUD_API',
            response,
            status,
            providerMessageId,
            messageId: logResult.insertId,
        };
    }
}

module.exports = MetaWhatsAppProvider;
