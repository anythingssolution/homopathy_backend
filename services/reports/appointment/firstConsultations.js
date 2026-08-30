const { buildAppointmentReportScope, query } = require('./shared');

/** Matches master_treatments used for a patient's first visit. */
const FIRST_CONSULTATION_SQL = `(
    UPPER(REPLACE(TRIM(COALESCE(t.treatment_code, '')), '-', '_')) = 'FIRST_CONSULTATION'
    OR LOWER(TRIM(t.treatment_name)) IN ('first consultation', 'first consult')
)`;

const getFirstConsultationsReport = async (filters) => {
    const { whereClause, params } = buildAppointmentReportScope(filters);

    return query(
        `SELECT
            a.appointment_id,
            a.appointment_date,
            a.status,
            a.current_token_number AS token_number,
            a.fk_patient_id,
            a.fk_patient_family_member_id,
            CONCAT(a.fk_patient_id, ':', COALESCE(a.fk_patient_family_member_id, 0)) AS person_key,
            COALESCE(fm.full_name, p.full_name) AS patient_full_name,
            p.mobile_no AS patient_mobile_no,
            b.branch_name,
            t.treatment_name,
            s.slot_name,
            CASE WHEN a.status = 'Completed' OR c.id IS NOT NULL THEN 1 ELSE 0 END AS is_consulted
         FROM tbl_appointments a
         JOIN master_treatments t ON t.id = a.fk_treatment_id
         JOIN master_clinic_branches b ON b.id = a.fk_branch_id
         JOIN master_slots s ON s.id = a.fk_slot_id
         LEFT JOIN master_users p ON p.id = a.fk_patient_id
         LEFT JOIN tbl_patient_family_members fm ON fm.id = a.fk_patient_family_member_id
         LEFT JOIN tbl_consultations c ON c.appointment_id = a.appointment_id
         ${whereClause}
           AND ${FIRST_CONSULTATION_SQL}
         ORDER BY a.appointment_date DESC, a.appointment_id DESC`,
        params
    );
};

module.exports = getFirstConsultationsReport;
