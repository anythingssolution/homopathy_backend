const asyncHandler = require('../../utils/asyncHandler');
const AppError = require('../../utils/AppError');
const { query } = require('../../config/db');
const WhatsAppProviderFactory = require('../../services/whatsapp/WhatsAppProviderFactory');
const {
    getDoctorWhatsAppSettings,
    syncFollowUpRemindersFromConsultations,
} = require('../../services/whatsappAutomationService');
const { getIO } = require('../../utils/realtime');

const toPositiveInt = (val) => {
    const p = Number(val);
    return Number.isInteger(p) && p > 0 ? p : null;
};

/**
 * List patient conversation threads
 */
const getMockConversations = asyncHandler(async (req, res) => {
    const { search } = req.query;

    const conditions = [`p.role = 'PAT'`, `p.is_active = 1`];
    const params = [];

    if (search && String(search).trim()) {
        conditions.push(`(p.full_name LIKE ? OR p.mobile_no LIKE ? OR p.whatsapp_number LIKE ?)`);
        const s = `%${String(search).trim()}%`;
        params.push(s, s, s);
    }

    const whereClause = `WHERE ${conditions.join(' AND ')}`;

    const rows = await query(
        `SELECT p.id AS patient_id, p.uuid AS patient_uuid, p.full_name AS patient_name,
                p.mobile_no, p.whatsapp_number, p.whatsapp_consent_status,
                (
                    SELECT m.message_text
                    FROM tbl_whatsapp_messages m
                    WHERE m.fk_patient_id = p.id
                    ORDER BY m.created_at DESC
                    LIMIT 1
                ) AS last_message_text,
                (
                    SELECT m.message_type
                    FROM tbl_whatsapp_messages m
                    WHERE m.fk_patient_id = p.id
                    ORDER BY m.created_at DESC
                    LIMIT 1
                ) AS last_message_type,
                (
                    SELECT m.status
                    FROM tbl_whatsapp_messages m
                    WHERE m.fk_patient_id = p.id
                    ORDER BY m.created_at DESC
                    LIMIT 1
                ) AS last_message_status,
                (
                    SELECT m.created_at
                    FROM tbl_whatsapp_messages m
                    WHERE m.fk_patient_id = p.id
                    ORDER BY m.created_at DESC
                    LIMIT 1
                ) AS last_message_at,
                (
                    SELECT COUNT(*)
                    FROM tbl_whatsapp_messages m
                    WHERE m.fk_patient_id = p.id
                ) AS total_messages
         FROM master_users p
         ${whereClause}
         ORDER BY (last_message_at IS NOT NULL) DESC, last_message_at DESC, p.full_name ASC
         LIMIT 100`,
        params
    );

    return res.status(200).json({
        success: true,
        message: 'Mock WhatsApp conversations fetched successfully',
        data: rows,
        provider: WhatsAppProviderFactory.getProvider().getProviderName(),
    });
});

/**
 * Get message history for a specific patient
 */
const getMockMessages = asyncHandler(async (req, res) => {
    const patientId = toPositiveInt(req.params.patient_id);
    if (!patientId) {
        throw new AppError('Valid patient_id is required', 400);
    }

    const patientRows = await query(
        `SELECT id, full_name, mobile_no, whatsapp_number, whatsapp_consent_status
         FROM master_users
         WHERE id = ? AND role = 'PAT'
         LIMIT 1`,
        [patientId]
    );

    if (!patientRows || patientRows.length === 0) {
        throw new AppError('Patient not found', 404);
    }

    const messages = await query(
        `SELECT m.id, m.fk_patient_id, m.fk_doctor_id, m.fk_branch_id, m.fk_appointment_id,
                m.fk_prescription_id, m.message_type, m.template_name, m.recipient_phone,
                m.message_text, m.media_url, m.provider_message_id, m.status, m.error_code,
                m.error_message, m.sent_at, m.delivered_at, m.read_at, m.failed_at, m.created_at,
                d.full_name AS doctor_name, b.branch_name
         FROM tbl_whatsapp_messages m
         LEFT JOIN master_users d ON d.id = m.fk_doctor_id
         LEFT JOIN master_clinic_branches b ON b.id = m.fk_branch_id
         WHERE m.fk_patient_id = ?
         ORDER BY m.created_at ASC`,
        [patientId]
    );

    return res.status(200).json({
        success: true,
        message: 'Mock WhatsApp message history fetched successfully',
        data: {
            patient: patientRows[0],
            messages,
        },
    });
});

/**
 * Send an outgoing or simulated incoming message
 */
const sendMockMessage = asyncHandler(async (req, res) => {
    const patientId = toPositiveInt(req.params.patient_id);
    const { text, message_type = 'TEXT', media_url = null, is_incoming = false } = req.body || {};

    if (!patientId) {
        throw new AppError('Valid patient_id is required', 400);
    }
    if (!text && !media_url) {
        throw new AppError('Message text or media URL is required', 400);
    }

    const patientRows = await query(
        `SELECT id, full_name, mobile_no, whatsapp_number, whatsapp_consent_status
         FROM master_users
         WHERE id = ? AND role = 'PAT'
         LIMIT 1`,
        [patientId]
    );

    if (!patientRows || patientRows.length === 0) {
        throw new AppError('Patient not found', 404);
    }

    const patient = patientRows[0];
    const recipientPhone = patient.whatsapp_number || patient.mobile_no || '919999999999';
    const provider = WhatsAppProviderFactory.getProvider();

    let result;
    if (message_type === 'DOCUMENT' && media_url) {
        result = await provider.sendDocumentMessage({
            mobileNo: recipientPhone,
            documentUrl: media_url,
            filename: 'Prescription.pdf',
            caption: text || '',
            patientId: patient.id,
            doctorId: req.user.id,
            createdBy: req.user.id,
        });
    } else {
        result = await provider.sendTextMessage({
            mobileNo: recipientPhone,
            message: String(text).trim(),
            patientId: patient.id,
            doctorId: req.user.id,
            createdBy: req.user.id,
        });
    }

    return res.status(200).json({
        success: true,
        message: 'Mock message sent successfully',
        data: result,
    });
});

/**
 * Manually update message status in simulation (Sent -> Delivered -> Read or Failed)
 */
const updateMockMessageStatus = asyncHandler(async (req, res) => {
    const messageId = toPositiveInt(req.params.id);
    const { status, error_message = null } = req.body || {};

    if (!messageId) {
        throw new AppError('Valid message id is required', 400);
    }

    const validStatuses = ['queued', 'sending', 'sent', 'delivered', 'read', 'failed'];
    if (!validStatuses.includes(String(status).toLowerCase())) {
        throw new AppError(`Invalid status. Must be one of: ${validStatuses.join(', ')}`, 400);
    }

    const newStatus = String(status).toLowerCase();

    let timeFieldUpdate = '';
    if (newStatus === 'sent') timeFieldUpdate = ', sent_at = NOW()';
    if (newStatus === 'delivered') timeFieldUpdate = ', delivered_at = NOW()';
    if (newStatus === 'read') timeFieldUpdate = ', read_at = NOW()';
    if (newStatus === 'failed') timeFieldUpdate = ', failed_at = NOW()';

    await query(
        `UPDATE tbl_whatsapp_messages
         SET status = ?,
             error_message = ?,
             error_code = CASE WHEN ? = 'failed' THEN 'SIMULATED_FAILURE' ELSE NULL END
             ${timeFieldUpdate}
         WHERE id = ?`,
        [newStatus, error_message || null, newStatus, messageId]
    );

    // Broadcast update
    try {
        const io = getIO();
        if (io) {
            io.emit('whatsapp.mock_status_updated', {
                id: messageId,
                status: newStatus,
                error_message,
                updated_at: new Date().toISOString(),
            });
        }
    } catch (err) {
        // Ignore
    }

    return res.status(200).json({
        success: true,
        message: `Message status updated to ${newStatus}`,
    });
});

/**
 * Time-Travel Scheduler Runner: evaluate scheduled reminders against a custom simulated date
 */
const runMockScheduler = asyncHandler(async (req, res) => {
    const { simulated_date } = req.body || {};

    const effectiveDate = simulated_date
        ? String(simulated_date).trim()
        : new Date().toISOString().split('T')[0];

    const effectiveCutoff = `${effectiveDate} 23:59:59`;

    // 1. Auto-sync active consultations that have current or future target dates
    try {
        await syncFollowUpRemindersFromConsultations();
    } catch (syncErr) {
        console.error('[runMockScheduler] Auto-sync consultation reminders error:', syncErr);
    }

    // 2. Automatically mark expired any reminders whose target_date is in the past
    await query(
        `UPDATE tbl_whatsapp_scheduled_messages
         SET status = 'CANCELLED', last_error = 'Expired: target follow-up date is in the past'
         WHERE status = 'PENDING' AND DATE(target_date) < ?`,
        [effectiveDate]
    );

    // 3. Find due messages strictly where scheduled_at <= cutoff AND target_date >= effectiveDate
    const rows = await query(
        `SELECT sm.id, sm.fk_consultation_id, sm.fk_appointment_id, sm.fk_patient_id, sm.fk_doctor_id,
                sm.fk_branch_id, sm.recipient_phone, sm.recipient_name, sm.recipient_type, sm.message_type,
                sm.template_name, sm.template_parameters_json, sm.media_url, sm.media_filename,
                sm.custom_message_text, sm.trigger_event, sm.target_date, sm.scheduled_at,
                sm.attempt_count, sm.max_attempts, sm.status,
                d.full_name AS doctor_name, p.full_name AS patient_name
         FROM tbl_whatsapp_scheduled_messages sm
         JOIN master_users p ON p.id = sm.fk_patient_id
         LEFT JOIN master_users d ON d.id = sm.fk_doctor_id
         WHERE sm.status = 'PENDING'
           AND sm.scheduled_at <= ?
           AND DATE(sm.target_date) >= ?
         ORDER BY sm.scheduled_at ASC
         LIMIT 50`,
        [effectiveCutoff, effectiveDate]
    );

    const provider = WhatsAppProviderFactory.getProvider();
    const results = [];

    for (const msg of rows) {
        // Check doctor settings
        if (msg.fk_doctor_id) {
            const docSettings = await getDoctorWhatsAppSettings(msg.fk_doctor_id);
            if (!docSettings.whatsapp_automation_enabled || !docSettings.followup_reminders_enabled) {
                await query(
                    `UPDATE tbl_whatsapp_scheduled_messages
                     SET status = 'CANCELLED', last_error = 'Skipped: Doctor follow-up automation is disabled'
                     WHERE id = ?`,
                    [msg.id]
                );
                results.push({
                    id: msg.id,
                    patient: msg.patient_name,
                    trigger_event: msg.trigger_event,
                    status: 'SKIPPED_DOCTOR_DISABLED',
                    reason: 'Doctor automation toggle is OFF',
                });
                continue;
            }
        }

        let params = [];
        try {
            if (msg.template_parameters_json) {
                params = typeof msg.template_parameters_json === 'string'
                    ? JSON.parse(msg.template_parameters_json)
                    : msg.template_parameters_json;
            }
        } catch (e) {
            params = [];
        }

        let sendRes;
        try {
            if (msg.message_type === 'DOCUMENT' && msg.media_url) {
                sendRes = await provider.sendDocumentMessage({
                    mobileNo: msg.recipient_phone,
                    documentUrl: msg.media_url,
                    filename: msg.media_filename || 'Prescription.pdf',
                    caption: msg.custom_message_text || '',
                    patientId: msg.fk_patient_id,
                    doctorId: msg.fk_doctor_id,
                    branchId: msg.fk_branch_id,
                    appointmentId: msg.fk_appointment_id,
                });
            } else if (msg.message_type === 'TEMPLATE' && msg.template_name) {
                sendRes = await provider.sendTemplateMessage({
                    mobileNo: msg.recipient_phone,
                    templateName: msg.template_name,
                    parameters: params,
                    patientId: msg.fk_patient_id,
                    doctorId: msg.fk_doctor_id,
                    branchId: msg.fk_branch_id,
                    appointmentId: msg.fk_appointment_id,
                });
            } else {
                sendRes = await provider.sendTextMessage({
                    mobileNo: msg.recipient_phone,
                    message: msg.custom_message_text || 'Reminder from Dr Trivedi Clinic',
                    patientId: msg.fk_patient_id,
                    doctorId: msg.fk_doctor_id,
                    branchId: msg.fk_branch_id,
                    appointmentId: msg.fk_appointment_id,
                });
            }

            await query(
                `UPDATE tbl_whatsapp_scheduled_messages
                 SET status = 'SENT', sent_at = NOW(), provider_message_id = ?, attempt_count = attempt_count + 1
                 WHERE id = ?`,
                [sendRes.providerMessageId || null, msg.id]
            );

            results.push({
                id: msg.id,
                patient: msg.patient_name,
                trigger_event: msg.trigger_event,
                target_date: msg.target_date,
                status: 'SENT',
                provider: provider.getProviderName(),
                message_id: sendRes.messageId,
            });
        } catch (err) {
            await query(
                `UPDATE tbl_whatsapp_scheduled_messages
                 SET status = 'FAILED', last_error = ?, attempt_count = attempt_count + 1
                 WHERE id = ?`,
                [err.message, msg.id]
            );
            results.push({
                id: msg.id,
                patient: msg.patient_name,
                trigger_event: msg.trigger_event,
                status: 'FAILED',
                error: err.message,
            });
        }
    }

    return res.status(200).json({
        success: true,
        message: `Processed ${results.length} due scheduled reminder(s)`,
        simulated_cutoff: effectiveCutoff,
        processed_count: results.length,
        results,
    });
});

/**
 * Get scheduled reminders queue
 */
const getMockScheduledQueue = asyncHandler(async (_req, res) => {
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
         ORDER BY sm.scheduled_at DESC
         LIMIT 100`
    );

    return res.status(200).json({
        success: true,
        message: 'Mock scheduled queue fetched successfully',
        data: rows,
    });
});

/**
 * Get comprehensive WhatsApp event audit logs
 */
const getMockEventLogs = asyncHandler(async (req, res) => {
    const { status, limit = 100 } = req.query;

    const conditions = ['1=1'];
    const params = [];

    if (status) {
        conditions.push('m.status = ?');
        params.push(String(status).trim());
    }

    const whereClause = `WHERE ${conditions.join(' AND ')}`;

    const rows = await query(
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
         LIMIT ?`,
        [...params, Number(limit)]
    );

    return res.status(200).json({
        success: true,
        message: 'Mock WhatsApp event logs fetched successfully',
        data: rows,
    });
});

module.exports = {
    getMockConversations,
    getMockMessages,
    sendMockMessage,
    updateMockMessageStatus,
    runMockScheduler,
    getMockScheduledQueue,
    getMockEventLogs,
};
