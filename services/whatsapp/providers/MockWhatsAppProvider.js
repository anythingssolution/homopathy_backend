const WhatsAppProviderInterface = require('./WhatsAppProviderInterface');
const { query } = require('../../../config/db');
const { getIO } = require('../../../utils/realtime');

class MockWhatsAppProvider extends WhatsAppProviderInterface {
    getProviderName() {
        return 'MOCK';
    }

    normalizeRecipient(mobileNo) {
        const digits = String(mobileNo || '').replace(/\D/g, '');
        if (!digits) {
            return '919999999999';
        }
        if (digits.length === 10) {
            return `91${digits}`;
        }
        return digits;
    }

    generateMockMessageId() {
        const rand = Math.random().toString(36).substring(2, 9);
        return `mock_msg_${Date.now()}_${rand}`;
    }

    async logMockMessage({
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
        providerMessageId,
        status = 'sent',
        errorCode = null,
        errorMessage = null,
        createdBy = null,
    }) {
        const result = await query(
            `INSERT INTO tbl_whatsapp_messages
             (fk_patient_id, fk_doctor_id, fk_branch_id, fk_appointment_id, fk_prescription_id,
              fk_bill_id, message_type, template_name, recipient_phone, message_text,
              media_url, provider_message_id, status, error_code, error_message,
              sent_at, delivered_at, created_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), DATE_ADD(NOW(), INTERVAL 2 SECOND), ?)`,
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
                createdBy,
            ]
        );

        const messageId = result.insertId;

        // Broadcast realtime event via Socket.io
        try {
            const io = getIO();
            if (io) {
                io.emit('whatsapp.mock_message_created', {
                    id: messageId,
                    patient_id: patientId,
                    doctor_id: doctorId,
                    branch_id: branchId,
                    appointment_id: appointmentId,
                    message_type: messageType,
                    template_name: templateName,
                    recipient_phone: recipientPhone,
                    message_text: messageText,
                    media_url: mediaUrl,
                    provider_message_id: providerMessageId,
                    status,
                    created_at: new Date().toISOString(),
                });
            }
        } catch (err) {
            console.error('[MockWhatsAppProvider] Socket broadcast error:', err);
        }

        // Auto-progress status in development simulation (Sent -> Delivered after 2s, Read after 4s)
        if (status === 'sent') {
            setTimeout(async () => {
                try {
                    await query(
                        `UPDATE tbl_whatsapp_messages
                         SET status = 'delivered', delivered_at = NOW()
                         WHERE id = ? AND status = 'sent'`,
                        [messageId]
                    );
                    const io = getIO();
                    if (io) {
                        io.emit('whatsapp.mock_status_updated', {
                            id: messageId,
                            status: 'delivered',
                            delivered_at: new Date().toISOString(),
                        });
                    }
                } catch (e) {
                    // Ignore background mock progression errors
                }
            }, 2000);
        }

        return {
            insertId: messageId,
            providerMessageId,
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
        const providerMessageId = this.generateMockMessageId();

        const logResult = await this.logMockMessage({
            patientId,
            doctorId,
            branchId,
            appointmentId,
            messageType: 'TEXT',
            recipientPhone: to,
            messageText: String(message || '').trim(),
            providerMessageId,
            status: 'sent',
            createdBy,
        });

        return {
            skipped: false,
            provider: 'MOCK',
            status: 'sent',
            providerMessageId,
            messageId: logResult.insertId,
            response: {
                messaging_product: 'whatsapp',
                messages: [{ id: providerMessageId }],
            },
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
        const providerMessageId = this.generateMockMessageId();

        // Build human-readable representation of template parameters
        let renderedText = `[Template: ${templateName}]`;
        if (templateName === 'followup_reminder_day_before' && parameters.length >= 4) {
            renderedText = `Hello ${parameters[0]}, this is a friendly reminder from Dr. ${parameters[1]} (${parameters[2]}). Your follow-up visit is scheduled for tomorrow, ${parameters[3]}.`;
        } else if (templateName === 'followup_reminder_today' && parameters.length >= 4) {
            renderedText = `Hello ${parameters[0]}, your follow-up visit with Dr. ${parameters[1]} at ${parameters[2]} is due today, ${parameters[3]}. Please visit during clinic consultation hours.`;
        } else if (templateName === 'prescription_ready_share' && parameters.length >= 5) {
            renderedText = `Dear ${parameters[0]}, here is the digital prescription from Dr. ${parameters[1]} for ${parameters[2]} (Visit Date: ${parameters[3]}). Access link: ${parameters[4]}`;
        } else if (parameters.length > 0) {
            renderedText = `Template ${templateName}: ${parameters.join(' | ')}`;
        }

        const logResult = await this.logMockMessage({
            patientId,
            doctorId,
            branchId,
            appointmentId,
            messageType: 'TEMPLATE',
            templateName,
            recipientPhone: to,
            messageText: renderedText,
            providerMessageId,
            status: 'sent',
            createdBy,
        });

        return {
            skipped: false,
            provider: 'MOCK',
            status: 'sent',
            providerMessageId,
            messageId: logResult.insertId,
            response: {
                messaging_product: 'whatsapp',
                messages: [{ id: providerMessageId }],
            },
        };
    }

    async sendDocumentMessage({
        mobileNo,
        documentUrl,
        filename = 'Prescription.pdf',
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
        const providerMessageId = this.generateMockMessageId();

        const logResult = await this.logMockMessage({
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
            status: 'sent',
            createdBy,
        });

        return {
            skipped: false,
            provider: 'MOCK',
            status: 'sent',
            providerMessageId,
            messageId: logResult.insertId,
            response: {
                messaging_product: 'whatsapp',
                messages: [{ id: providerMessageId }],
            },
        };
    }
}

module.exports = MockWhatsAppProvider;
