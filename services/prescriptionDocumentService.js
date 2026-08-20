const { query } = require('../config/db');
const AppError = require('../utils/AppError');
const {
    sendWhatsAppDocumentMessage,
    sendWhatsAppTemplateMessage,
    sendWhatsAppTextMessage,
} = require('../utils/whatsappService');
const { getDoctorWhatsAppSettings } = require('./whatsappAutomationService');

/**
 * Get recipient contact choices for sending prescription (Self vs Family Member)
 */
const getPrescriptionRecipientOptions = async (consultationId) => {
    const consultationRows = await query(
        `SELECT c.id AS consultation_id, c.appointment_id, c.doctor_id,
                a.fk_patient_id, a.fk_patient_family_member_id, a.appointment_date,
                p.id AS patient_id, p.full_name AS patient_name, p.mobile_no AS patient_mobile,
                p.whatsapp_number AS patient_whatsapp, p.whatsapp_consent_status,
                d.full_name AS doctor_name, b.branch_name
         FROM tbl_consultations c
         JOIN tbl_appointments a ON a.appointment_id = c.appointment_id
         JOIN master_users p ON p.id = a.fk_patient_id
         LEFT JOIN master_users d ON d.id = c.doctor_id
         LEFT JOIN master_clinic_branches b ON b.id = a.fk_branch_id
         WHERE c.id = ?
         LIMIT 1`,
        [consultationId]
    );

    if (!consultationRows || consultationRows.length === 0) {
        throw new AppError('Consultation or prescription not found', 404);
    }

    const item = consultationRows[0];

    // Fetch family members of this patient
    const familyRows = await query(
        `SELECT id, full_name, relationship, mobile_no, is_active
         FROM tbl_patient_family_members
         WHERE fk_primary_patient_id = ? AND is_active = 1
         ORDER BY id ASC`,
        [item.patient_id]
    );

    const primaryPhone = item.patient_whatsapp || item.patient_mobile;

    const recipients = [
        {
            id: 'SELF',
            type: 'PATIENT',
            family_member_id: null,
            name: item.patient_name,
            relationship: 'Self (Patient)',
            phone: primaryPhone,
            consent_status: item.whatsapp_consent_status,
            is_default: !item.fk_patient_family_member_id,
        },
    ];

    familyRows.forEach((fm) => {
        const fmPhone = fm.mobile_no || primaryPhone;
        recipients.push({
            id: `FAMILY_${fm.id}`,
            type: 'FAMILY_MEMBER',
            family_member_id: fm.id,
            name: fm.full_name,
            relationship: fm.relationship || 'Family Member',
            phone: fmPhone,
            consent_status: item.whatsapp_consent_status,
            is_default: item.fk_patient_family_member_id === fm.id,
        });
    });

    return {
        consultation_id: item.consultation_id,
        appointment_id: item.appointment_id,
        patient_id: item.patient_id,
        patient_name: item.patient_name,
        doctor_name: item.doctor_name,
        branch_name: item.branch_name,
        appointment_date: item.appointment_date,
        recipients,
    };
};

/**
 * Send prescription PDF / summary to a patient or family member
 */
const sendPrescriptionViaWhatsApp = async ({
    consultationId,
    doctorId,
    recipientPhone,
    recipientName,
    recipientType = 'PATIENT',
    familyMemberId = null,
    customMessage = '',
    actorId = null,
}) => {
    if (!recipientPhone) {
        throw new AppError('A valid recipient phone number is required', 400);
    }

    // Verify doctor settings
    const docSettings = await getDoctorWhatsAppSettings(doctorId);
    if (!docSettings.whatsapp_automation_enabled || !docSettings.prescription_sharing_enabled) {
        throw new AppError('Prescription sharing via WhatsApp is currently disabled in your settings', 403);
    }

    const consultationRows = await query(
        `SELECT c.id AS consultation_id, c.appointment_id, c.doctor_id,
                a.fk_patient_id, a.fk_branch_id, a.appointment_date,
                p.id AS patient_id, p.full_name AS patient_name,
                d.full_name AS doctor_name, b.branch_name
         FROM tbl_consultations c
         JOIN tbl_appointments a ON a.appointment_id = c.appointment_id
         JOIN master_users p ON p.id = a.fk_patient_id
         LEFT JOIN master_users d ON d.id = c.doctor_id
         LEFT JOIN master_clinic_branches b ON b.id = a.fk_branch_id
         WHERE c.id = ?
         LIMIT 1`,
        [consultationId]
    );

    if (!consultationRows || consultationRows.length === 0) {
        throw new AppError('Consultation not found', 404);
    }

    const consult = consultationRows[0];
    const visitDate = consult.appointment_date
        ? new Date(consult.appointment_date).toLocaleDateString('en-IN', {
            day: 'numeric',
            month: 'short',
            year: 'numeric',
        })
        : 'Recent Visit';

    // Build message text
    let messageBody = customMessage.trim();
    if (!messageBody) {
        messageBody = `Dear ${recipientName || consult.patient_name}, here is the prescription from Dr. ${consult.doctor_name || 'Dr. Trivedi'} (${consult.branch_name || 'Clinic'}) for visit on ${visitDate}. Please follow all dosage instructions as advised.`;
    }

    const sendResult = await sendWhatsAppTextMessage({
        mobileNo: recipientPhone,
        message: messageBody,
        patientId: consult.patient_id,
        doctorId: consult.doctor_id,
        branchId: consult.fk_branch_id,
        appointmentId: consult.appointment_id,
        createdBy: actorId,
    });

    return {
        success: sendResult.status === 'sent' || sendResult.status === 'delivered',
        status: sendResult.status,
        recipient: {
            phone: recipientPhone,
            name: recipientName,
            type: recipientType,
            family_member_id: familyMemberId,
        },
        provider_message_id: sendResult.providerMessageId,
        message_id: sendResult.messageId,
    };
};

module.exports = {
    getPrescriptionRecipientOptions,
    sendPrescriptionViaWhatsApp,
};
