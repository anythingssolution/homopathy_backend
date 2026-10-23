const { query } = require('../config/db');
const AppError = require('../utils/AppError');

const SOURCE_LABELS = Object.freeze({
    FACEBOOK: 'Facebook', INSTAGRAM: 'Instagram', GOOGLE: 'Google / Google Maps',
    YOUTUBE: 'YouTube', FAMILY_FRIEND: 'Family / Friend', DOCTOR: 'Another Doctor', OTHER: 'Other',
});
const validateAnswer = (body) => {
    const source = String(body?.source_code || '').trim().toUpperCase();
    if (!Object.hasOwn(SOURCE_LABELS, source)) throw new AppError('Please select a valid source', 400);
    const detail = source === 'OTHER' ? String(body?.other_detail || '').trim() : null;
    if (source === 'OTHER' && (!detail || detail.length > 255)) throw new AppError('Please describe the source in 1–255 characters', 400);
    return { source_code: source, other_detail: detail };
};
const getOwnedSubject = async (appointmentId, patientId) => {
    if (!Number.isSafeInteger(Number(appointmentId)) || Number(appointmentId) <= 0) throw new AppError('Valid appointment is required', 400);
    const rows = await query(`SELECT appointment_id, fk_patient_id, fk_patient_family_member_id
        FROM tbl_appointments WHERE appointment_id = ? AND fk_patient_id = ? LIMIT 1`, [Number(appointmentId), patientId]);
    if (!rows.length) throw new AppError('Appointment not found', 404);
    const appointment = rows[0];
    return { ...appointment, subject_key: appointment.fk_patient_family_member_id
        ? `FM:${appointment.fk_patient_family_member_id}` : `PAT:${appointment.fk_patient_id}` };
};
const getDiscoverySource = async (appointmentId, patientId) => {
    const subject = await getOwnedSubject(appointmentId, patientId);
    const rows = await query('SELECT source_code, other_detail FROM tbl_patient_discovery_sources WHERE subject_key = ? AND patient_id = ? LIMIT 1', [subject.subject_key, patientId]);
    return rows[0] || null;
};
const saveDiscoverySource = async (appointmentId, patientId, body) => {
    const answer = validateAnswer(body);
    const subject = await getOwnedSubject(appointmentId, patientId);
    // Concurrent/repeated requests keep the first answer and its original booking attribution.
    await query(`INSERT INTO tbl_patient_discovery_sources
        (subject_key, patient_id, family_member_id, appointment_id, source_code, other_detail)
        VALUES (?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE subject_key = VALUES(subject_key)`,
    [subject.subject_key, patientId, subject.fk_patient_family_member_id || null, subject.appointment_id, answer.source_code, answer.other_detail]);
    return getDiscoverySource(appointmentId, patientId);
};
const getPatientSourceReport = async ({ branchId, fromDate, toDate }) => {
    if (!Number.isSafeInteger(Number(branchId)) || Number(branchId) <= 0) throw new AppError('Please select a branch', 400);
    const patients = await query(`SELECT d.subject_key, d.source_code, d.other_detail,
        DATE_FORMAT(d.created_at, '%Y-%m-%d') AS answered_on,
        DATE_FORMAT(a.appointment_date, '%Y-%m-%d') AS booking_date,
        p.id AS patient_id, p.uuid AS patient_uuid, p.mobile_no AS patient_mobile_no,
        d.family_member_id, COALESCE(fm.full_name, p.full_name) AS patient_full_name
        FROM tbl_patient_discovery_sources d
        JOIN tbl_appointments a ON a.appointment_id = d.appointment_id
        JOIN master_users p ON p.id = d.patient_id
        LEFT JOIN tbl_patient_family_members fm ON fm.id = d.family_member_id
        WHERE a.fk_branch_id = ? AND d.created_at >= ? AND d.created_at < DATE_ADD(?, INTERVAL 1 DAY)
        ORDER BY d.created_at DESC, d.subject_key`, [branchId, fromDate, toDate]);
    return { patients, sources: Object.entries(SOURCE_LABELS).map(([code, label]) => ({ code, label, count: patients.filter(p => p.source_code === code).length })) };
};
module.exports = { SOURCE_LABELS, validateAnswer, getOwnedSubject, getDiscoverySource, saveDiscoverySource, getPatientSourceReport };
