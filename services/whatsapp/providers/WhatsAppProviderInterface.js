/**
 * WhatsApp Provider Interface Contract
 */
class WhatsAppProviderInterface {
    /**
     * Send a plain text WhatsApp message
     */
    async sendTextMessage({ mobileNo, message, patientId, doctorId, branchId, appointmentId, createdBy }) {
        throw new Error('sendTextMessage must be implemented by subclass');
    }

    /**
     * Send a template WhatsApp message
     */
    async sendTemplateMessage({ mobileNo, templateName, languageCode, parameters, patientId, doctorId, branchId, appointmentId, createdBy }) {
        throw new Error('sendTemplateMessage must be implemented by subclass');
    }

    /**
     * Send a document (PDF, file) WhatsApp message
     */
    async sendDocumentMessage({ mobileNo, documentUrl, filename, caption, patientId, doctorId, branchId, appointmentId, prescriptionId, billId, createdBy }) {
        throw new Error('sendDocumentMessage must be implemented by subclass');
    }

    /**
     * Provider identification name
     */
    getProviderName() {
        return 'UNKNOWN';
    }
}

module.exports = WhatsAppProviderInterface;
