const { buildClinicalReportScope, query } = require('./shared');

const getConsultationHistoryReport = async (filters) => {
    const { whereClause, params } = buildClinicalReportScope(filters);

    return query(
        `SELECT
            c.id AS consultation_id,
            c.appointment_id,
            a.appointment_date,
            a.current_token_number AS token_number,
            COALESCE(fm.full_name, p.full_name) AS patient_full_name,
            p.mobile_no AS patient_mobile_no,
            d.full_name AS doctor_name,
            b.branch_name,
            t.treatment_name,
            c.consultation_mode,
            c.disease,
            c.diagnosis,
            c.workflow_status,
            c.created_at
         FROM tbl_consultations c
         JOIN tbl_appointments a ON a.appointment_id = c.appointment_id
         JOIN master_users p ON p.id = a.fk_patient_id
         LEFT JOIN tbl_patient_family_members fm ON fm.id = a.fk_patient_family_member_id
         JOIN master_users d ON d.id = c.doctor_id
         JOIN master_clinic_branches b ON b.id = a.fk_branch_id
         JOIN master_treatments t ON t.id = a.fk_treatment_id
         ${whereClause}
         ORDER BY a.appointment_date DESC, c.created_at DESC`,
        params
    );
};

module.exports = getConsultationHistoryReport;
