const asyncHandler = require('../../utils/asyncHandler');
const AppError = require('../../utils/AppError');
const { query } = require('../../config/db');
const {
    sendWhatsAppTextMessage,
    sendWhatsAppTemplateMessage,
    sendWhatsAppDocumentMessage,
} = require('../../utils/whatsappService');
const {
    listWhatsAppTemplates,
    getWhatsAppTemplateByName,
} = require('../../services/whatsappTemplateService');
const {
    getDoctorWhatsAppSettings,
    updateDoctorWhatsAppSettings,
    cancelScheduledReminders,
} = require('../../services/whatsappAutomationService');
const {
    getPrescriptionRecipientOptions,
    sendPrescriptionViaWhatsApp,
} = require('../../services/prescriptionDocumentService');

const toPositiveInt = (val) => {
    const p = Number(val);
    return Number.isInteger(p) && p > 0 ? p : null;
};

/**
 * Send Direct or Template WhatsApp Message
 */
const sendWhatsAppMessage = asyncHandler(async (req, res) => {
    const {
        patient_id,
        message_type = 'TEXT',
        template_name,
        text,
        parameters = [],
        appointment_id = null,
        branch_id = null,
    } = req.body || {};

    const patientId = toPositiveInt(patient_id);
    if (!patientId) {
        throw new AppError('patient_id is required', 400);
    }

    const patientRows = await query(
        `SELECT id, mobile_no, whatsapp_number, whatsapp_consent_status
         FROM master_users
         WHERE id = ? AND role = 'PAT' AND is_active = 1
         LIMIT 1`,
        [patientId]
    );

    if (!patientRows || patientRows.length === 0) {
        throw new AppError('Patient not found or inactive', 404);
    }

    const patient = patientRows[0];
    if (patient.whatsapp_consent_status === 'OPTED_OUT') {
        throw new AppError('Patient has opted out of receiving WhatsApp messages', 400);
    }

    const recipientPhone = patient.whatsapp_number || patient.mobile_no;

    const doctorId = (req.user.role === 'doctor' || req.user.role_code === 'DOC')
        ? req.user.id
        : (toPositiveInt(req.body.doctor_id) || 1);

    let result;
    if (message_type === 'TEMPLATE') {
        if (!template_name) {
            throw new AppError('template_name is required for TEMPLATE message type', 400);
        }

        const template = await getWhatsAppTemplateByName(template_name);

        result = await sendWhatsAppTemplateMessage({
            mobileNo: recipientPhone,
            templateName: template.template_name,
            languageCode: template.language_code,
            parameters: Array.isArray(parameters) ? parameters : [],
            patientId: patient.id,
            doctorId,
            branchId: toPositiveInt(branch_id) || req.user.selected_branch_id || req.user.branch_id || null,
            appointmentId: toPositiveInt(appointment_id),
            createdBy: req.user.id,
        });
    } else {
        if (!text || String(text).trim() === '') {
            throw new AppError('text is required for TEXT message type', 400);
        }

        result = await sendWhatsAppTextMessage({
            mobileNo: recipientPhone,
            message: String(text).trim(),
            patientId: patient.id,
            doctorId,
            branchId: toPositiveInt(branch_id) || req.user.selected_branch_id || req.user.branch_id || null,
            appointmentId: toPositiveInt(appointment_id),
            createdBy: req.user.id,
        });
    }

    return res.status(200).json({
        success: result.status === 'sent' || result.status === 'delivered',
        message: result.skipped ? 'WhatsApp message skipped (configuration missing)' : 'WhatsApp message processed',
        data: result,
    });
});

/**
 * Send WhatsApp Document (PDF Prescription, Invoice, Report)
 */
const sendWhatsAppDocument = asyncHandler(async (req, res) => {
    const {
        patient_id,
        document_url,
        filename = 'Document.pdf',
        caption = '',
        appointment_id = null,
        branch_id = null,
        prescription_id = null,
        bill_id = null,
    } = req.body || {};

    const patientId = toPositiveInt(patient_id);
    if (!patientId) {
        throw new AppError('patient_id is required', 400);
    }
    if (!document_url) {
        throw new AppError('document_url is required', 400);
    }

    const patientRows = await query(
        `SELECT id, mobile_no, whatsapp_number, whatsapp_consent_status
         FROM master_users
         WHERE id = ? AND role = 'PAT' AND is_active = 1
         LIMIT 1`,
        [patientId]
    );

    if (!patientRows || patientRows.length === 0) {
        throw new AppError('Patient not found or inactive', 404);
    }

    const patient = patientRows[0];
    if (patient.whatsapp_consent_status === 'OPTED_OUT') {
        throw new AppError('Patient has opted out of receiving WhatsApp messages', 400);
    }

    const recipientPhone = patient.whatsapp_number || patient.mobile_no;
    const doctorId = (req.user.role === 'doctor' || req.user.role_code === 'DOC')
        ? req.user.id
        : (toPositiveInt(req.body.doctor_id) || 1);

    const result = await sendWhatsAppDocumentMessage({
        mobileNo: recipientPhone,
        documentUrl: document_url,
        filename,
        caption,
        patientId: patient.id,
        doctorId,
        branchId: toPositiveInt(branch_id) || req.user.selected_branch_id || req.user.branch_id || null,
        appointmentId: toPositiveInt(appointment_id),
        prescriptionId: toPositiveInt(prescription_id),
        billId: toPositiveInt(bill_id),
        createdBy: req.user.id,
    });

    return res.status(200).json({
        success: result.status === 'sent' || result.status === 'delivered',
        message: result.skipped ? 'WhatsApp document skipped (configuration missing)' : 'WhatsApp document processed',
        data: result,
    });
});

/**
 * Get WhatsApp Delivery History with Search & Filter
 */
const getWhatsAppHistory = asyncHandler(async (req, res) => {
    const { patient_id, appointment_id, status, search, limit = 50, offset = 0 } = req.query;

    const conditions = ['1=1'];
    const params = [];

    if (patient_id) {
        conditions.push('m.fk_patient_id = ?');
        params.push(toPositiveInt(patient_id));
    }
    if (appointment_id) {
        conditions.push('m.fk_appointment_id = ?');
        params.push(toPositiveInt(appointment_id));
    }
    if (status && status !== 'ALL') {
        conditions.push('m.status = ?');
        params.push(String(status).toLowerCase().trim());
    }
    if (search && String(search).trim()) {
        conditions.push('(p.full_name LIKE ? OR m.recipient_phone LIKE ? OR m.message_text LIKE ?)');
        const s = `%${String(search).trim()}%`;
        params.push(s, s, s);
    }

    const whereClause = `WHERE ${conditions.join(' AND ')}`;

    const countRows = await query(
        `SELECT COUNT(*) AS total
         FROM tbl_whatsapp_messages m
         JOIN master_users p ON p.id = m.fk_patient_id
         ${whereClause}`,
        params
    );

    const messages = await query(
        `SELECT m.id, m.fk_patient_id, m.fk_doctor_id, m.fk_branch_id, m.fk_appointment_id,
                m.fk_prescription_id, m.message_type, m.template_name, m.recipient_phone,
                m.message_text, m.media_url, m.provider_message_id, m.status, m.error_code,
                m.error_message, m.sent_at, m.delivered_at, m.read_at, m.failed_at, m.created_at,
                p.full_name AS patient_name, d.full_name AS doctor_name, b.branch_name
         FROM tbl_whatsapp_messages m
         JOIN master_users p ON p.id = m.fk_patient_id
         LEFT JOIN master_users d ON d.id = m.fk_doctor_id
         LEFT JOIN master_clinic_branches b ON b.id = m.fk_branch_id
         ${whereClause}
         ORDER BY m.created_at DESC
         LIMIT ? OFFSET ?`,
        [...params, Number(limit), Number(offset)]
    );

    return res.status(200).json({
        success: true,
        message: 'WhatsApp message history fetched successfully',
        data: messages,
        total: countRows?.[0]?.total || messages.length,
    });
});

/**
 * Get Comprehensive WhatsApp Analytics & KPI Metrics
 */
const getWhatsAppAnalytics = asyncHandler(async (req, res) => {
    // 1. Overall Aggregates
    const [statsRows] = await query(`
        SELECT
            COUNT(*) AS total_messages,
            SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) AS sent_count,
            SUM(CASE WHEN status = 'delivered' THEN 1 ELSE 0 END) AS delivered_count,
            SUM(CASE WHEN status = 'read' THEN 1 ELSE 0 END) AS read_count,
            SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed_count,
            SUM(CASE WHEN message_type = 'DOCUMENT' THEN 1 ELSE 0 END) AS prescriptions_shared,
            SUM(CASE WHEN template_name LIKE '%followup%' THEN 1 ELSE 0 END) AS followup_reminders_sent,
            SUM(CASE WHEN message_type = 'TEXT' THEN 1 ELSE 0 END) AS direct_texts_sent
        FROM tbl_whatsapp_messages
    `);

    const stats = statsRows || {
        total_messages: 0,
        sent_count: 0,
        delivered_count: 0,
        read_count: 0,
        failed_count: 0,
        prescriptions_shared: 0,
        followup_reminders_sent: 0,
        direct_texts_sent: 0,
    };

    const deliveredOrRead = Number(stats.delivered_count || 0) + Number(stats.read_count || 0);
    const total = Number(stats.total_messages || 0);
    const deliveryRate = total > 0 ? Math.round((deliveredOrRead / total) * 100) : 100;
    const readRate = deliveredOrRead > 0 ? Math.round((Number(stats.read_count || 0) / deliveredOrRead) * 100) : 0;

    // 2. Scheduled Queue Summary (Active future/current)
    const queueRows = await query(`
        SELECT
            status,
            COUNT(*) AS count
        FROM tbl_whatsapp_scheduled_messages
        WHERE DATE(target_date) >= CURDATE()
        GROUP BY status
    `);

    const queueSummary = {
        PENDING: 0,
        PROCESSING: 0,
        SENT: 0,
        CANCELLED: 0,
        FAILED: 0,
    };
    queueRows.forEach((r) => {
        if (queueSummary[r.status] !== undefined) {
            queueSummary[r.status] = Number(r.count);
        }
    });

    // 3. Past 7 Days Trend
    const trendRows = await query(`
        SELECT
            DATE(created_at) AS message_date,
            COUNT(*) AS total,
            SUM(CASE WHEN status IN ('delivered', 'read', 'sent') THEN 1 ELSE 0 END) AS successful,
            SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
        FROM tbl_whatsapp_messages
        WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)
        GROUP BY DATE(created_at)
        ORDER BY message_date ASC
    `);

    // 4. Latest 5 Active Scheduled Reminders
    const upcomingScheduled = await query(`
        SELECT sm.id, sm.recipient_name, sm.recipient_phone, sm.trigger_event,
               sm.target_date, sm.scheduled_at, sm.status, sm.template_name
        FROM tbl_whatsapp_scheduled_messages sm
        WHERE sm.status = 'PENDING'
          AND DATE(sm.target_date) >= CURDATE()
        ORDER BY sm.scheduled_at ASC
        LIMIT 5
    `);

    return res.status(200).json({
        success: true,
        message: 'WhatsApp analytics fetched successfully',
        data: {
            kpis: {
                total_messages: total,
                sent_count: Number(stats.sent_count || 0),
                delivered_count: Number(stats.delivered_count || 0),
                read_count: Number(stats.read_count || 0),
                failed_count: Number(stats.failed_count || 0),
                delivery_rate_percent: deliveryRate,
                read_rate_percent: readRate,
                prescriptions_shared: Number(stats.prescriptions_shared || 0),
                followup_reminders_sent: Number(stats.followup_reminders_sent || 0),
                direct_texts_sent: Number(stats.direct_texts_sent || 0),
            },
            queue_summary: queueSummary,
            trend_7days: trendRows,
            upcoming_scheduled: upcomingScheduled,
        },
    });
});

/**
 * List Template Master Catalog
 */
const getTemplates = asyncHandler(async (req, res) => {
    const templates = await listWhatsAppTemplates();
    return res.status(200).json({
        success: true,
        message: 'WhatsApp templates fetched successfully',
        data: templates,
    });
});

/**
 * Update Patient WhatsApp Consent / Opt-in status
 */
const updatePatientConsent = asyncHandler(async (req, res) => {
    const patientId = toPositiveInt(req.params.id);
    const { whatsapp_consent_status, whatsapp_number = null } = req.body || {};

    if (!patientId) {
        throw new AppError('Valid patient id is required', 400);
    }

    if (!['OPTED_IN', 'OPTED_OUT', 'UNSPECIFIED'].includes(whatsapp_consent_status)) {
        throw new AppError('Invalid whatsapp_consent_status value', 400);
    }

    await query(
        `UPDATE master_users
         SET whatsapp_consent_status = ?,
             whatsapp_number = COALESCE(?, whatsapp_number),
             whatsapp_consent_updated_at = NOW()
         WHERE id = ? AND role = 'PAT'`,
        [whatsapp_consent_status, whatsapp_number ? String(whatsapp_number).trim() : null, patientId]
    );

    return res.status(200).json({
        success: true,
        message: 'Patient WhatsApp preferences updated successfully',
    });
});

/**
 * Get Doctor/Clinic WhatsApp automation & toggle settings
 */
const getDoctorSettings = asyncHandler(async (req, res) => {
    const doctorId = toPositiveInt(req.query.doctor_id)
        || (req.user.role === 'doctor' || req.user.role_code === 'DOC' ? req.user.id : 1);

    const settings = await getDoctorWhatsAppSettings(doctorId);

    return res.status(200).json({
        success: true,
        message: 'WhatsApp doctor settings fetched successfully',
        data: settings,
    });
});

/**
 * Update Doctor WhatsApp automation preferences
 */
const updateDoctorSettings = asyncHandler(async (req, res) => {
    const doctorId = toPositiveInt(req.body.doctor_id)
        || toPositiveInt(req.query.doctor_id)
        || (req.user.role === 'doctor' || req.user.role_code === 'DOC' ? req.user.id : 1);

    const settings = await updateDoctorWhatsAppSettings(doctorId, req.body || {});

    return res.status(200).json({
        success: true,
        message: 'WhatsApp doctor settings updated successfully',
        data: settings,
    });
});

/**
 * Get recipient choices for prescription sharing
 */
const getPrescriptionRecipients = asyncHandler(async (req, res) => {
    const consultationId = toPositiveInt(req.params.consultation_id);
    if (!consultationId) {
        throw new AppError('Valid consultation_id is required', 400);
    }

    const data = await getPrescriptionRecipientOptions(consultationId);

    return res.status(200).json({
        success: true,
        message: 'Prescription recipients fetched successfully',
        data,
    });
});

/**
 * Send prescription to chosen patient/family recipient via WhatsApp
 */
const sharePrescription = asyncHandler(async (req, res) => {
    const consultationId = toPositiveInt(req.params.consultation_id);
    const { recipient_phone, recipient_name, recipient_type, family_member_id, custom_message, doctor_id } = req.body || {};

    if (!consultationId) {
        throw new AppError('Valid consultation_id is required', 400);
    }

    const resolvedDoctorId = (req.user.role === 'doctor' || req.user.role_code === 'DOC')
        ? req.user.id
        : (toPositiveInt(doctor_id) || 1);

    const result = await sendPrescriptionViaWhatsApp({
        consultationId,
        doctorId: resolvedDoctorId,
        recipientPhone: recipient_phone,
        recipientName: recipient_name,
        recipientType: recipient_type,
        familyMemberId: toPositiveInt(family_member_id),
        customMessage: custom_message || '',
        actorId: req.user.id,
    });

    return res.status(200).json({
        success: result.success,
        message: result.success ? 'Prescription sent via WhatsApp successfully' : 'Prescription message failed or queued',
        data: result,
    });
});

/**
 * List scheduled reminders with Search & Filter
 */
const getScheduledReminders = asyncHandler(async (req, res) => {
    const { status, search, limit = 50, offset = 0 } = req.query;

    const conditions = ['DATE(sm.target_date) >= CURDATE()'];
    const params = [];

    if (status && status !== 'ALL') {
        conditions.push('sm.status = ?');
        params.push(String(status).toUpperCase().trim());
    }

    if (search && String(search).trim()) {
        conditions.push('(p.full_name LIKE ? OR sm.recipient_phone LIKE ?)');
        const s = `%${String(search).trim()}%`;
        params.push(s, s);
    }

    const whereClause = `WHERE ${conditions.join(' AND ')}`;

    const countRows = await query(
        `SELECT COUNT(*) AS total
         FROM tbl_whatsapp_scheduled_messages sm
         JOIN master_users p ON p.id = sm.fk_patient_id
         ${whereClause}`,
        params
    );

    const rows = await query(
        `SELECT sm.id, sm.fk_consultation_id, sm.fk_appointment_id, sm.fk_patient_id, sm.fk_doctor_id,
                sm.fk_branch_id, sm.recipient_phone, sm.recipient_name, sm.recipient_type, sm.message_type,
                sm.template_name, sm.trigger_event, sm.target_date, sm.scheduled_at, sm.status,
                sm.attempt_count, sm.max_attempts, sm.last_error, sm.sent_at, sm.provider_message_id,
                sm.created_at,
                p.full_name AS patient_name, d.full_name AS doctor_name, b.branch_name
         FROM tbl_whatsapp_scheduled_messages sm
         JOIN master_users p ON p.id = sm.fk_patient_id
         LEFT JOIN master_users d ON d.id = sm.fk_doctor_id
         LEFT JOIN master_clinic_branches b ON b.id = sm.fk_branch_id
         ${whereClause}
         ORDER BY sm.scheduled_at ASC
         LIMIT ? OFFSET ?`,
        [...params, Number(limit), Number(offset)]
    );

    return res.status(200).json({
        success: true,
        message: 'Scheduled reminders fetched successfully',
        data: rows,
        total: countRows?.[0]?.total || rows.length,
    });
});

/**
 * Cancel scheduled reminder manually
 */
const cancelScheduledReminder = asyncHandler(async (req, res) => {
    const reminderId = toPositiveInt(req.params.id);
    if (!reminderId) {
        throw new AppError('Valid reminder id is required', 400);
    }

    await query(
        `UPDATE tbl_whatsapp_scheduled_messages
         SET status = 'CANCELLED', last_error = 'Manually cancelled by user'
         WHERE id = ? AND status IN ('PENDING', 'PROCESSING')`,
        [reminderId]
    );

    return res.status(200).json({
        success: true,
        message: 'Scheduled reminder cancelled successfully',
    });
});

module.exports = {
    sendWhatsAppMessage,
    sendWhatsAppDocument,
    getWhatsAppHistory,
    getWhatsAppAnalytics,
    getTemplates,
    updatePatientConsent,
    getDoctorSettings,
    updateDoctorSettings,
    getPrescriptionRecipients,
    sharePrescription,
    getScheduledReminders,
    cancelScheduledReminder,
};
