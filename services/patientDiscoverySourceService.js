const { buildReportBranchSql, requireReportBranch } = require('../utils/reportBranchSql');
const { query } = require('../config/db');
const AppError = require('../utils/AppError');

const SOURCE_LABELS = Object.freeze({
    FACEBOOK: 'Facebook', INSTAGRAM: 'Instagram', GOOGLE: 'Google / Google Maps',
    YOUTUBE: 'YouTube', FAMILY_FRIEND: 'Family / Friend', DOCTOR: 'Another Doctor', OTHER: 'Other', NOT_KNOWN: 'Patient does not know',
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
const getPatientSourceReport = async (filters) => {
    const { fromDate, toDate } = filters;
    requireReportBranch(filters);
    const branch = buildReportBranchSql('a.fk_branch_id', filters);
    const patients = await query(`SELECT d.subject_key, d.source_code, d.other_detail,
        DATE_FORMAT(d.created_at, '%Y-%m-%d') AS answered_on,
        DATE_FORMAT(a.appointment_date, '%Y-%m-%d') AS booking_date,
        p.id AS patient_id, p.uuid AS patient_uuid, p.mobile_no AS patient_mobile_no,
        d.family_member_id, COALESCE(fm.full_name, p.full_name) AS patient_full_name,
        a.fk_branch_id, br.branch_name
        FROM tbl_patient_discovery_sources d
        JOIN tbl_appointments a ON a.appointment_id = d.appointment_id
        JOIN master_users p ON p.id = d.patient_id
        LEFT JOIN master_clinic_branches br ON br.id = a.fk_branch_id
        LEFT JOIN tbl_patient_family_members fm ON fm.id = d.family_member_id
        WHERE ${branch.sql} AND d.created_at >= ? AND d.created_at < DATE_ADD(?, INTERVAL 1 DAY)
        ORDER BY d.created_at DESC, d.subject_key`, [...branch.params, fromDate, toDate]);
    return { patients, sources: Object.entries(SOURCE_LABELS).map(([code, label]) => ({ code, label, count: patients.filter(p => p.source_code === code).length })) };
};
module.exports = { SOURCE_LABELS, validateAnswer, getOwnedSubject, getDiscoverySource, saveDiscoverySource, getPatientSourceReport };

// Staff routes apply module and branch/booking-ownership authorization first.
const getStaffSubject = async (appointmentId, actorId = null) => {
    if (!Number.isSafeInteger(Number(appointmentId)) || Number(appointmentId) <= 0) throw new AppError('Valid appointment is required', 400);
    const rows = await query(`SELECT appointment_id, fk_patient_id, fk_patient_family_member_id FROM tbl_appointments WHERE appointment_id = ?${actorId ? ' AND booked_by_user_id = ?' : ''} LIMIT 1`, actorId ? [Number(appointmentId), actorId] : [Number(appointmentId)]);
    if (!rows.length) throw new AppError('Appointment not found', 404);
    return rows[0];
};
const getStaffSource = async (appointmentId, actorId = null) => {
    const subject = await getStaffSubject(appointmentId, actorId);
    return getDiscoverySource(subject.appointment_id, subject.fk_patient_id);
};
const saveStaffSource = async (appointmentId, body, actorId = null) => {
    const subject = await getStaffSubject(appointmentId, actorId);
    const answer = validateAnswer(body);
    // First attribution stays on the original appointment; explicit staff correction updates only the answer.
    if (body?.replace_existing === true) {
        const key = subject.fk_patient_family_member_id ? `FM:${subject.fk_patient_family_member_id}` : `PAT:${subject.fk_patient_id}`;
        await query('UPDATE tbl_patient_discovery_sources SET source_code = ?, other_detail = ? WHERE subject_key = ? AND patient_id = ?', [answer.source_code, answer.other_detail, key, subject.fk_patient_id]);
    }
    return saveDiscoverySource(subject.appointment_id, subject.fk_patient_id, body);
};
const getPendingReceptionSource = async actorId => {
    const rows = await query(`SELECT p.appointment_id FROM tbl_reception_discovery_pending p
      JOIN tbl_appointments a ON a.appointment_id = p.appointment_id
      LEFT JOIN tbl_patient_discovery_sources d ON d.subject_key = CASE WHEN a.fk_patient_family_member_id IS NULL THEN CONCAT('PAT:', a.fk_patient_id) ELSE CONCAT('FM:', a.fk_patient_family_member_id) END
      WHERE p.actor_id = ? AND a.booked_by_user_id = p.actor_id AND a.is_active = 1 AND a.status <> 'Cancelled' AND d.subject_key IS NULL
      ORDER BY p.appointment_id ASC LIMIT 1`, [actorId]);
    return rows[0] || null;
};
module.exports.getStaffSource = getStaffSource;
module.exports.saveStaffSource = saveStaffSource;
module.exports.getPendingReceptionSource = getPendingReceptionSource;
