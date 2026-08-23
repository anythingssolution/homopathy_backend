const { query, withTransaction } = require('../config/db');
const {
    sendWhatsAppTemplateMessage,
    sendWhatsAppTextMessage,
    sendWhatsAppDocumentMessage,
    isWhatsAppConfigured,
} = require('../utils/whatsappService');

const DEFAULT_DOCTOR_SETTINGS = {
    whatsapp_automation_enabled: 1,
    followup_reminders_enabled: 1,
    prescription_sharing_enabled: 1,
    appointment_confirmation_enabled: 1,
    reminder_time_x_minus_1: '10:00:00',
    reminder_time_x: '09:00:00',
};

let schedulerIntervalTimer = null;
let isProcessingQueue = false;
let missingScheduledMessagesTableLogged = false;

const isMissingScheduledMessagesTable = (error) => {
    if (!error || error.code !== 'ER_NO_SUCH_TABLE') {
        return false;
    }

    return String(error.sqlMessage || error.message || '').includes('tbl_whatsapp_scheduled_messages');
};

const dbExecute = async (sql, params = [], connection = null) => {
    if (connection) {
        const [res] = await connection.execute(sql, params);
        return res;
    }
    return query(sql, params);
};

/**
 * Fetch or initialize WhatsApp settings for a doctor
 */
const getDoctorWhatsAppSettings = async (doctorId, connection = null) => {
    const rows = await dbExecute(
        `SELECT doctor_id, whatsapp_automation_enabled, followup_reminders_enabled,
                prescription_sharing_enabled, appointment_confirmation_enabled,
                reminder_time_x_minus_1, reminder_time_x, updated_at
         FROM tbl_whatsapp_doctor_settings
         WHERE doctor_id = ?
         LIMIT 1`,
        [doctorId],
        connection
    );

    if (rows && rows.length > 0) {
        return {
            ...DEFAULT_DOCTOR_SETTINGS,
            ...rows[0],
            whatsapp_automation_enabled: Boolean(rows[0].whatsapp_automation_enabled),
            followup_reminders_enabled: Boolean(rows[0].followup_reminders_enabled),
            prescription_sharing_enabled: Boolean(rows[0].prescription_sharing_enabled),
            appointment_confirmation_enabled: Boolean(rows[0].appointment_confirmation_enabled),
        };
    }

    // Default settings if not explicitly configured
    return {
        doctor_id: doctorId,
        ...DEFAULT_DOCTOR_SETTINGS,
        whatsapp_automation_enabled: true,
        followup_reminders_enabled: true,
        prescription_sharing_enabled: true,
        appointment_confirmation_enabled: true,
    };
};

/**
 * Upsert doctor WhatsApp automation preferences
 */
const updateDoctorWhatsAppSettings = async (doctorId, settings, connection = null) => {
    const automationEnabled = settings.whatsapp_automation_enabled !== undefined
        ? (settings.whatsapp_automation_enabled ? 1 : 0) : 1;
    const remindersEnabled = settings.followup_reminders_enabled !== undefined
        ? (settings.followup_reminders_enabled ? 1 : 0) : 1;
    const prescriptionEnabled = settings.prescription_sharing_enabled !== undefined
        ? (settings.prescription_sharing_enabled ? 1 : 0) : 1;
    const confirmationEnabled = settings.appointment_confirmation_enabled !== undefined
        ? (settings.appointment_confirmation_enabled ? 1 : 0) : 1;
    const timeXMinus1 = settings.reminder_time_x_minus_1 || '10:00:00';
    const timeX = settings.reminder_time_x || '09:00:00';

    await dbExecute(
        `INSERT INTO tbl_whatsapp_doctor_settings
         (doctor_id, whatsapp_automation_enabled, followup_reminders_enabled,
          prescription_sharing_enabled, appointment_confirmation_enabled,
          reminder_time_x_minus_1, reminder_time_x)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
          whatsapp_automation_enabled = VALUES(whatsapp_automation_enabled),
          followup_reminders_enabled = VALUES(followup_reminders_enabled),
          prescription_sharing_enabled = VALUES(prescription_sharing_enabled),
          appointment_confirmation_enabled = VALUES(appointment_confirmation_enabled),
          reminder_time_x_minus_1 = VALUES(reminder_time_x_minus_1),
          reminder_time_x = VALUES(reminder_time_x),
          updated_at = CURRENT_TIMESTAMP`,
        [doctorId, automationEnabled, remindersEnabled, prescriptionEnabled, confirmationEnabled, timeXMinus1, timeX],
        connection
    );

    return getDoctorWhatsAppSettings(doctorId, connection);
};

/**
 * Format a Date object to YYYY-MM-DD
 */
const formatDateYMD = (dateObj) => {
    const d = new Date(dateObj);
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
};

/**
 * Format a Date string nicely for user-facing WhatsApp templates (e.g., 20 Aug 2026)
 */
const formatDisplayDate = (dateString) => {
    if (!dateString) return '';
    const date = new Date(dateString);
    if (Number.isNaN(date.getTime())) return String(dateString);
    return date.toLocaleDateString('en-IN', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
    });
};

/**
 * Schedule automated Follow-up Reminders (Day X-1 and Day X)
 */
const scheduleFollowUpReminders = async ({
    consultationId,
    appointmentId,
    doctorId,
    patientId,
    branchId,
    appointmentDate,
    followUpAfterDays = 15,
    connection = null,
}) => {
    const days = Number(followUpAfterDays);
    if (!days || days <= 0) return { scheduled: false, reason: 'invalid_followup_days' };

    // 1. Cancel any existing pending reminders for this consultation
    await cancelScheduledReminders({ consultationId, appointmentId, reason: 'RESCHEDULED_OR_UPDATED', connection });

    // 2. Fetch doctor settings
    const docSettings = await getDoctorWhatsAppSettings(doctorId, connection);
    if (!docSettings.whatsapp_automation_enabled || !docSettings.followup_reminders_enabled) {
        return { scheduled: false, reason: 'doctor_automation_disabled' };
    }

    // 3. Fetch patient, doctor and branch metadata
    const patientRows = await dbExecute(
        `SELECT id, full_name, mobile_no, whatsapp_number, whatsapp_consent_status
         FROM master_users
         WHERE id = ? LIMIT 1`,
        [patientId],
        connection
    );
    if (!patientRows || patientRows.length === 0) {
        return { scheduled: false, reason: 'patient_not_found' };
    }
    const patient = patientRows[0];

    // Check WhatsApp consent
    if (patient.whatsapp_consent_status === 'OPTED_OUT') {
        return { scheduled: false, reason: 'patient_opted_out' };
    }

    const recipientPhone = patient.whatsapp_number || patient.mobile_no;
    if (!recipientPhone) {
        return { scheduled: false, reason: 'missing_recipient_phone' };
    }

    const docRows = await dbExecute(
        `SELECT id, full_name FROM master_users WHERE id = ? LIMIT 1`,
        [doctorId],
        connection
    );
    const doctorName = docRows?.[0]?.full_name || 'Dr. Trivedi';

    let branchName = 'Dr Trivedi Clinic';
    if (branchId) {
        const branchRows = await dbExecute(
            `SELECT id, branch_name FROM master_clinic_branches WHERE id = ? LIMIT 1`,
            [branchId],
            connection
        );
        if (branchRows?.[0]?.branch_name) {
            branchName = branchRows[0].branch_name;
        }
    }

    // 4. Calculate Target Dates (Day X and Day X-1)
    const baseDate = new Date(appointmentDate || new Date());
    const targetDateObj = new Date(baseDate);
    targetDateObj.setDate(targetDateObj.getDate() + days);

    const xMinus1DateObj = new Date(targetDateObj);
    xMinus1DateObj.setDate(xMinus1DateObj.getDate() - 1);

    const targetDateStr = formatDateYMD(targetDateObj);
    const xMinus1DateStr = formatDateYMD(xMinus1DateObj);
    const todayStr = formatDateYMD(new Date());

    // Never schedule reminders for past expired follow-up dates
    if (targetDateStr < todayStr) {
        return { scheduled: false, reason: 'past_target_date_expired' };
    }

    const displayTargetDate = formatDisplayDate(targetDateStr);

    const timeXMinus1 = docSettings.reminder_time_x_minus_1 || '10:00:00';
    const timeX = docSettings.reminder_time_x || '09:00:00';

    const scheduledAtXMinus1 = `${xMinus1DateStr} ${timeXMinus1}`;
    const scheduledAtX = `${targetDateStr} ${timeX}`;

    const idempotencyXMinus1 = `followup_${consultationId}_xminus1_${targetDateStr}`;
    const idempotencyX = `followup_${consultationId}_x_${targetDateStr}`;

    const templateParams = [
        patient.full_name,
        doctorName,
        branchName,
        displayTargetDate,
    ];

    // 5. Insert Scheduled Messages (only future/current due)
    const scheduledItems = [];
    if (xMinus1DateStr >= todayStr) {
        scheduledItems.push({
            trigger_event: 'FOLLOWUP_X_MINUS_1',
            target_date: targetDateStr,
            scheduled_at: scheduledAtXMinus1,
            idempotency_key: idempotencyXMinus1,
            template_name: 'followup_reminder_day_before',
            custom_text: `Hello ${patient.full_name}, reminder from Dr. ${doctorName} (${branchName}). Your follow-up visit is scheduled for tomorrow, ${displayTargetDate}.`,
        });
    }

    if (targetDateStr >= todayStr) {
        scheduledItems.push({
            trigger_event: 'FOLLOWUP_X',
            target_date: targetDateStr,
            scheduled_at: scheduledAtX,
            idempotency_key: idempotencyX,
            template_name: 'followup_reminder_today',
            custom_text: `Hello ${patient.full_name}, your follow-up visit with Dr. ${doctorName} at ${branchName} is due today, ${displayTargetDate}. Please visit during clinic hours.`,
        });
    }

    for (const item of scheduledItems) {
        await dbExecute(
            `INSERT INTO tbl_whatsapp_scheduled_messages
             (fk_consultation_id, fk_appointment_id, fk_patient_id, fk_doctor_id, fk_branch_id,
              recipient_phone, recipient_name, recipient_type, message_type, template_name,
              template_parameters_json, custom_message_text, trigger_event, target_date,
              scheduled_at, status, idempotency_key, attempt_count, max_attempts)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'PATIENT', 'TEMPLATE', ?, ?, ?, ?, ?, ?, 'PENDING', ?, 0, 3)
             ON DUPLICATE KEY UPDATE
              scheduled_at = VALUES(scheduled_at),
              status = 'PENDING',
              template_parameters_json = VALUES(template_parameters_json),
              custom_message_text = VALUES(custom_message_text),
              updated_at = CURRENT_TIMESTAMP`,
            [
                consultationId,
                appointmentId,
                patientId,
                doctorId,
                branchId,
                recipientPhone,
                patient.full_name,
                item.template_name,
                JSON.stringify(templateParams),
                item.custom_text,
                item.trigger_event,
                item.target_date,
                item.scheduled_at,
                item.idempotency_key,
            ],
            connection
        );
    }

    return {
        scheduled: true,
        target_date: targetDateStr,
        scheduled_reminders: scheduledItems.map((it) => ({
            event: it.trigger_event,
            scheduled_at: it.scheduled_at,
        })),
    };
};

/**
 * Schedule automated reminders for an upcoming booked appointment (Day X-1 and Day X)
 */
const scheduleAppointmentReminders = async ({
    appointmentId,
    patientId,
    doctorId = null,
    branchId = null,
    appointmentDate,
    connection = null,
}) => {
    if (!appointmentId || !patientId || !appointmentDate) {
        return { scheduled: false, reason: 'missing_required_fields' };
    }

    // 1. Cancel any existing pending reminders for this appointment
    await cancelScheduledReminders({ appointmentId, reason: 'APPOINTMENT_RESCHEDULED', connection });

    // 2. Fetch doctor settings (or default)
    const docSettings = doctorId ? await getDoctorWhatsAppSettings(doctorId, connection) : DEFAULT_DOCTOR_SETTINGS;
    if (!docSettings.whatsapp_automation_enabled || !docSettings.followup_reminders_enabled) {
        return { scheduled: false, reason: 'automation_disabled' };
    }

    // 3. Fetch patient metadata
    const patientRows = await dbExecute(
        `SELECT id, full_name, mobile_no, whatsapp_number, whatsapp_consent_status
         FROM master_users
         WHERE id = ? LIMIT 1`,
        [patientId],
        connection
    );
    if (!patientRows || patientRows.length === 0) {
        return { scheduled: false, reason: 'patient_not_found' };
    }
    const patient = patientRows[0];

    if (patient.whatsapp_consent_status === 'OPTED_OUT') {
        return { scheduled: false, reason: 'patient_opted_out' };
    }

    const recipientPhone = patient.whatsapp_number || patient.mobile_no;
    if (!recipientPhone) {
        return { scheduled: false, reason: 'missing_recipient_phone' };
    }

    let doctorName = 'Dr. Trivedi';
    if (doctorId) {
        const docRows = await dbExecute(
            `SELECT id, full_name FROM master_users WHERE id = ? LIMIT 1`,
            [doctorId],
            connection
        );
        if (docRows?.[0]?.full_name) doctorName = docRows[0].full_name;
    }

    let branchName = 'Dr Trivedi Clinic';
    if (branchId) {
        const branchRows = await dbExecute(
            `SELECT id, branch_name FROM master_clinic_branches WHERE id = ? LIMIT 1`,
            [branchId],
            connection
        );
        if (branchRows?.[0]?.branch_name) branchName = branchRows[0].branch_name;
    }

    // 4. Calculate Dates (Day X is appointment date, Day X-1 is 1 day before)
    const targetDateObj = new Date(appointmentDate);
    const targetDateStr = formatDateYMD(targetDateObj);
    const todayStr = formatDateYMD(new Date());

    if (targetDateStr < todayStr) {
        return { scheduled: false, reason: 'past_appointment_date_expired' };
    }

    const displayTargetDate = formatDisplayDate(targetDateStr);

    const xMinus1DateObj = new Date(targetDateObj);
    xMinus1DateObj.setDate(xMinus1DateObj.getDate() - 1);
    const xMinus1DateStr = formatDateYMD(xMinus1DateObj);

    const timeXMinus1 = docSettings.reminder_time_x_minus_1 || '10:00:00';
    const timeX = docSettings.reminder_time_x || '09:00:00';

    const scheduledAtXMinus1 = `${xMinus1DateStr} ${timeXMinus1}`;
    const scheduledAtX = `${targetDateStr} ${timeX}`;

    const idempotencyXMinus1 = `app_${appointmentId}_xminus1_${targetDateStr}`;
    const idempotencyX = `app_${appointmentId}_x_${targetDateStr}`;

    const templateParams = [
        patient.full_name,
        doctorName,
        branchName,
        displayTargetDate,
    ];

    const scheduledItems = [];
    if (xMinus1DateStr >= todayStr) {
        scheduledItems.push({
            trigger_event: 'FOLLOWUP_X_MINUS_1',
            target_date: targetDateStr,
            scheduled_at: scheduledAtXMinus1,
            idempotency_key: idempotencyXMinus1,
            template_name: 'followup_reminder_day_before',
            custom_text: `Hello ${patient.full_name}, reminder from Dr. ${doctorName} (${branchName}). Your clinic appointment is scheduled for tomorrow, ${displayTargetDate}.`,
        });
    }
    if (targetDateStr >= todayStr) {
        scheduledItems.push({
            trigger_event: 'FOLLOWUP_X',
            target_date: targetDateStr,
            scheduled_at: scheduledAtX,
            idempotency_key: idempotencyX,
            template_name: 'followup_reminder_today',
            custom_text: `Hello ${patient.full_name}, your clinic appointment with Dr. ${doctorName} at ${branchName} is due today, ${displayTargetDate}. Please visit during clinic consultation hours.`,
        });
    }

    for (const item of scheduledItems) {
        await dbExecute(
            `INSERT INTO tbl_whatsapp_scheduled_messages
             (fk_appointment_id, fk_patient_id, fk_doctor_id, fk_branch_id,
              recipient_phone, recipient_name, recipient_type, message_type, template_name,
              template_parameters_json, custom_message_text, trigger_event, target_date,
              scheduled_at, status, idempotency_key, attempt_count, max_attempts)
             VALUES (?, ?, ?, ?, ?, ?, 'PATIENT', 'TEMPLATE', ?, ?, ?, ?, ?, ?, 'PENDING', ?, 0, 3)
             ON DUPLICATE KEY UPDATE
              scheduled_at = VALUES(scheduled_at),
              status = 'PENDING',
              template_parameters_json = VALUES(template_parameters_json),
              custom_message_text = VALUES(custom_message_text),
              updated_at = CURRENT_TIMESTAMP`,
            [
                appointmentId,
                patientId,
                doctorId,
                branchId,
                recipientPhone,
                patient.full_name,
                item.template_name,
                JSON.stringify(templateParams),
                item.custom_text,
                item.trigger_event,
                item.target_date,
                item.scheduled_at,
                item.idempotency_key,
            ],
            connection
        );
    }

    return {
        scheduled: true,
        target_date: targetDateStr,
        scheduled_reminders: scheduledItems.map((it) => ({
            event: it.trigger_event,
            scheduled_at: it.scheduled_at,
        })),
    };
};

/**
 * Cancel scheduled reminders for a given consultation or appointment
 */
const cancelScheduledReminders = async ({
    consultationId = null,
    appointmentId = null,
    reason = 'CANCELLED',
    connection = null,
}) => {
    if (!consultationId && !appointmentId) return 0;

    const conditions = [`status IN ('PENDING', 'PROCESSING')`];
    const params = [reason];

    if (consultationId) {
        conditions.push(`fk_consultation_id = ?`);
        params.push(consultationId);
    } else if (appointmentId) {
        conditions.push(`fk_appointment_id = ?`);
        params.push(appointmentId);
    }

    const result = await dbExecute(
        `UPDATE tbl_whatsapp_scheduled_messages
         SET status = 'CANCELLED',
             last_error = CONCAT('Cancelled: ', ?)
         WHERE ${conditions.join(' AND ')}`,
        params,
        connection
    );

    return result?.affectedRows || 0;
};

/**
 * Auto-sync follow-up reminders for active consultations & upcoming appointments (CURRENT/FUTURE DATES ONLY)
 */
const syncFollowUpRemindersFromConsultations = async () => {
    let count = 0;

    // 1. Sync from completed consultations strictly where target follow-up date >= CURDATE()
    const activeConsultations = await query(`
        SELECT c.id AS consultation_id, c.appointment_id, c.doctor_id, c.follow_up_after_days,
               a.appointment_date, a.fk_patient_id, a.fk_branch_id
        FROM tbl_consultations c
        JOIN tbl_appointments a ON a.appointment_id = c.appointment_id
        WHERE c.follow_up_chain_closed = 0
          AND c.follow_up_after_days > 0
          AND a.fk_patient_id IS NOT NULL
          AND DATE_ADD(DATE(a.appointment_date), INTERVAL c.follow_up_after_days DAY) >= CURDATE()
        ORDER BY c.id DESC
    `);

    for (const c of activeConsultations) {
        try {
            const res = await scheduleFollowUpReminders({
                consultationId: c.consultation_id,
                appointmentId: c.appointment_id,
                doctorId: c.doctor_id,
                patientId: c.fk_patient_id,
                branchId: c.fk_branch_id,
                appointmentDate: c.appointment_date,
                followUpAfterDays: c.follow_up_after_days,
            });
            if (res.scheduled) count++;
        } catch (e) {
            // continue
        }
    }

    // 2. Sync from upcoming booked/pending appointments strictly where appointment_date >= CURDATE()
    const upcomingAppointments = await query(`
        SELECT a.appointment_id, a.fk_patient_id, a.fk_branch_id, a.appointment_date, a.status,
               (SELECT doctor_id FROM tbl_consultations WHERE appointment_id = a.appointment_id LIMIT 1) AS doctor_id
        FROM tbl_appointments a
        WHERE a.status IN ('Pending', 'Confirmed', 'Booked', 'PENDING', 'CONFIRMED')
          AND a.fk_patient_id IS NOT NULL
          AND DATE(a.appointment_date) >= CURDATE()
        ORDER BY a.appointment_id DESC
    `);

    for (const app of upcomingAppointments) {
        try {
            const res = await scheduleAppointmentReminders({
                appointmentId: app.appointment_id,
                patientId: app.fk_patient_id,
                doctorId: app.doctor_id || 1,
                branchId: app.fk_branch_id,
                appointmentDate: app.appointment_date,
            });
            if (res.scheduled) count++;
        } catch (e) {
            // continue
        }
    }

    return count;
};

/**
 * Process due scheduled WhatsApp messages queue (CURRENT / FUTURE TARGET DATES ONLY)
 */
const processDueScheduledMessages = async () => {
    if (isProcessingQueue) return;
    isProcessingQueue = true;

    try {
        // Cancel any stale/past expired reminders
        await query(
            `UPDATE tbl_whatsapp_scheduled_messages
             SET status = 'CANCELLED', last_error = 'Expired: target follow-up date is in the past'
             WHERE status = 'PENDING' AND target_date < CURDATE()`
        );

        // Fetch up to 20 due messages strictly for current / future target dates
        const rows = await query(
            `SELECT id, fk_consultation_id, fk_appointment_id, fk_patient_id, fk_doctor_id, fk_branch_id,
                    recipient_phone, recipient_name, recipient_type, message_type, template_name,
                    template_parameters_json, media_url, media_filename, custom_message_text,
                    trigger_event, target_date, scheduled_at, attempt_count, max_attempts
             FROM tbl_whatsapp_scheduled_messages
             WHERE status = 'PENDING'
               AND scheduled_at <= NOW()
               AND target_date >= CURDATE()
             ORDER BY scheduled_at ASC
             LIMIT 20`
        );

        if (!rows || rows.length === 0) {
            isProcessingQueue = false;
            return;
        }

        for (const msg of rows) {
            // Lock and mark PROCESSING atomically
            const lockResult = await query(
                `UPDATE tbl_whatsapp_scheduled_messages
                 SET status = 'PROCESSING', updated_at = NOW()
                 WHERE id = ? AND status = 'PENDING'`,
                [msg.id]
            );

            if (lockResult.affectedRows === 0) continue;

            // Check doctor toggle in real-time
            if (msg.fk_doctor_id) {
                const docSettings = await getDoctorWhatsAppSettings(msg.fk_doctor_id);
                if (!docSettings.whatsapp_automation_enabled || !docSettings.followup_reminders_enabled) {
                    await query(
                        `UPDATE tbl_whatsapp_scheduled_messages
                         SET status = 'CANCELLED', last_error = 'Doctor follow-up automation toggle is OFF'
                         WHERE id = ?`,
                        [msg.id]
                    );
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

            try {
                let sendResult;
                if (msg.message_type === 'DOCUMENT' && msg.media_url) {
                    sendResult = await sendWhatsAppDocumentMessage({
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
                    sendResult = await sendWhatsAppTemplateMessage({
                        mobileNo: msg.recipient_phone,
                        templateName: msg.template_name,
                        parameters: params,
                        patientId: msg.fk_patient_id,
                        doctorId: msg.fk_doctor_id,
                        branchId: msg.fk_branch_id,
                        appointmentId: msg.fk_appointment_id,
                    });
                } else {
                    sendResult = await sendWhatsAppTextMessage({
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
                     SET status = 'SENT',
                         sent_at = NOW(),
                         provider_message_id = ?,
                         attempt_count = attempt_count + 1
                     WHERE id = ?`,
                    [sendResult.providerMessageId || null, msg.id]
                );
            } catch (err) {
                const nextAttempt = msg.attempt_count + 1;
                const newStatus = nextAttempt >= msg.max_attempts ? 'FAILED' : 'PENDING';
                await query(
                    `UPDATE tbl_whatsapp_scheduled_messages
                     SET status = ?,
                         attempt_count = ?,
                         last_error = ?,
                         scheduled_at = DATE_ADD(NOW(), INTERVAL ? MINUTE)
                     WHERE id = ?`,
                    [newStatus, nextAttempt, err.message, nextAttempt * 5, msg.id]
                );
            }
        }
    } catch (queueErr) {
        if (isMissingScheduledMessagesTable(queueErr)) {
            if (!missingScheduledMessagesTableLogged) {
                console.warn('[WhatsApp Automation] tbl_whatsapp_scheduled_messages is missing. Run npm run migrate to create WhatsApp tables.');
                missingScheduledMessagesTableLogged = true;
            }
            return;
        }

        console.error('[WhatsApp Automation Worker Error]:', queueErr);
    } finally {
        isProcessingQueue = false;
    }
};

/**
 * Start recurring background scheduler worker
 */
const startWhatsAppScheduler = (intervalMs = 60000) => {
    if (schedulerIntervalTimer) {
        clearInterval(schedulerIntervalTimer);
    }

    console.log(`[WhatsApp Automation] Scheduler worker initialized (polling every ${intervalMs / 1000}s)`);

    // Run first check after 5 seconds on startup
    setTimeout(() => {
        processDueScheduledMessages();
    }, 5000);

    schedulerIntervalTimer = setInterval(() => {
        processDueScheduledMessages();
    }, intervalMs);

    return schedulerIntervalTimer;
};

const stopWhatsAppScheduler = () => {
    if (schedulerIntervalTimer) {
        clearInterval(schedulerIntervalTimer);
        schedulerIntervalTimer = null;
    }
};

module.exports = {
    getDoctorWhatsAppSettings,
    updateDoctorWhatsAppSettings,
    scheduleFollowUpReminders,
    scheduleAppointmentReminders,
    cancelScheduledReminders,
    syncFollowUpRemindersFromConsultations,
    processDueScheduledMessages,
    startWhatsAppScheduler,
    stopWhatsAppScheduler,
};
