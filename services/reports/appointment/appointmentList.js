const { buildAppointmentReportScope, query } = require('./shared');
const { consultationPositionSql } = require('../../../utils/consultationPosition');
const { decorateTokenFields } = require('../../../utils/tokenDisplay');
const AppError = require('../../../utils/AppError');

const CARD_STATUSES = {
    all: ['Pending', 'Confirmed', 'Completed', 'Cancelled'],
    completed: ['Completed'],
    pending: ['Pending', 'Confirmed'],
    cancelled: ['Cancelled'],
};

const getAppointmentList = async (filters) => {
    const statuses = CARD_STATUSES[filters.status];
    if (!Object.hasOwn(CARD_STATUSES, filters.status)) throw new AppError('Invalid appointment card status', 400);
    const { whereClause, params } = buildAppointmentReportScope(filters);
    // Keep the same scope as statusAppointments: inactive/cancelled bookings
    // are part of those card counts too. Do not apply Who Came's consulted rule.
    const rows = await query(`SELECT
        a.appointment_id, DATE_FORMAT(a.appointment_date,'%Y-%m-%d') AS appointment_date,
        a.status, a.reception_status, a.reception_rejection_reason,
        a.original_token_number, a.current_token_number AS token_number,
        ${consultationPositionSql} AS queue_position,
        a.fk_patient_id, a.fk_patient_family_member_id AS family_member_id,
        COALESCE(fm.full_name,p.full_name) AS patient_full_name,
        p.uuid AS patient_uuid, p.mobile_no AS patient_mobile_no,
        t.treatment_name, s.slot_name, s.start_time,
        c.id AS consultation_id, c.workflow_status,
        (EXISTS (SELECT 1 FROM tbl_appointments history
            WHERE history.fk_patient_id=a.fk_patient_id AND history.fk_branch_id=a.fk_branch_id
              AND history.is_active=1 AND history.status='Completed')
         OR EXISTS (SELECT 1 FROM tbl_bills history_bill
            WHERE history_bill.patient_id=a.fk_patient_id AND history_bill.fk_branch_id=a.fk_branch_id)) AS has_history
        FROM tbl_appointments a
        LEFT JOIN master_users p ON p.id=a.fk_patient_id
        LEFT JOIN tbl_patient_family_members fm ON fm.id=a.fk_patient_family_member_id
        LEFT JOIN master_treatments t ON t.id=a.fk_treatment_id
        LEFT JOIN master_slots s ON s.id=a.fk_slot_id
        LEFT JOIN tbl_consultations c ON c.id=(SELECT MAX(latest.id) FROM tbl_consultations latest WHERE latest.appointment_id=a.appointment_id)
        ${whereClause} AND a.status IN (${statuses.map(() => '?').join(',')})
        ORDER BY a.appointment_date DESC, s.start_time ASC,
            CASE WHEN a.status='Completed' THEN a.actual_completed_at END DESC,
            a.current_token_number ASC, a.appointment_id DESC`, [...params, ...statuses]);
    return { rows: rows.map(row => decorateTokenFields(row)) };
};

module.exports = { getAppointmentList, CARD_STATUSES };
