const { query } = require('../config/db');
const AppError = require('../utils/AppError');

const getConsultationPreferences = async (doctorId, execute = query) => {
    try {
        const rows = await execute('SELECT consultation_autofill_enabled FROM master_users WHERE id = ? LIMIT 1', [doctorId]);
        if (!rows.length) throw new AppError('Doctor not found', 404);
        return { autofill_last_visit: Number(rows[0].consultation_autofill_enabled) === 1, available: true };
    } catch (error) {
        // Old deployments remain usable until the additive migration is applied.
        if (error.code === 'ER_BAD_FIELD_ERROR') return { autofill_last_visit: false, available: false };
        throw error;
    }
};

const saveConsultationPreferences = async (doctorId, enabled, execute = query) => {
    if (typeof enabled !== 'boolean') throw new AppError('autofill_last_visit must be true or false', 400);
    try {
        await execute('UPDATE master_users SET consultation_autofill_enabled = ? WHERE id = ?', [enabled ? 1 : 0, doctorId]);
    } catch (error) {
        if (error.code === 'ER_BAD_FIELD_ERROR') throw new AppError('Auto-fill setup is pending. Please contact the administrator.', 503);
        throw error;
    }
    return getConsultationPreferences(doctorId, execute);
};

const findLastCompletedVisit = async (appointment, execute = query) => {
    const rows = await execute(
        `SELECT c.id AS consultation_id, a.appointment_id, a.appointment_date,
                a.fk_branch_id AS branch_id, b.branch_name,
                COALESCE(a.actual_completed_at, c.doctor_finalized_at, c.created_at) AS consulted_at
         FROM tbl_consultations c
         JOIN tbl_appointments a ON a.appointment_id = c.appointment_id
         JOIN master_clinic_branches b ON b.id = a.fk_branch_id
         WHERE a.fk_patient_id = ? AND a.fk_patient_family_member_id <=> ?
           AND a.appointment_id <> ? AND a.is_active = 1 AND a.status = 'Completed'
           AND a.appointment_date <= ?
           AND COALESCE(a.actual_completed_at, c.doctor_finalized_at, c.created_at) <= COALESCE(?, NOW())
         ORDER BY a.appointment_date DESC, consulted_at DESC, c.id DESC LIMIT 1`,
        [appointment.fk_patient_id || appointment.patient_id,
            Number(appointment.fk_patient_family_member_id) || null, appointment.appointment_id,
            appointment.appointment_date, appointment.actual_started_at || null]
    );
    return rows[0] || null;
};

module.exports = { getConsultationPreferences, saveConsultationPreferences, findLastCompletedVisit };
