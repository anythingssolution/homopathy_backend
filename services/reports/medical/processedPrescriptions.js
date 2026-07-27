const { buildMedicalReportScope, query } = require('./shared');

const getProcessedPrescriptionsReport = async (filters) => {
    const { whereClause, params } = buildMedicalReportScope(filters);

    return query(
        `SELECT
            c.id AS consultation_id,
            c.appointment_id,
            c.workflow_status,
            c.medical_processed_at,
            processor.full_name AS medical_processed_by_name,
            a.appointment_date,
            a.current_token_number AS token_number,
            COALESCE(fm.full_name, p.full_name) AS patient_full_name,
            p.mobile_no AS patient_mobile_no,
            d.full_name AS doctor_name,
            b.branch_name,
            t.treatment_name
         FROM tbl_consultations c
         JOIN tbl_appointments a ON a.appointment_id = c.appointment_id
         JOIN master_users p ON p.id = a.fk_patient_id
         LEFT JOIN tbl_patient_family_members fm ON fm.id = a.fk_patient_family_member_id
         JOIN master_users d ON d.id = c.doctor_id
         LEFT JOIN master_users processor ON processor.id = c.medical_processed_by
         JOIN master_clinic_branches b ON b.id = a.fk_branch_id
         JOIN master_treatments t ON t.id = a.fk_treatment_id
         ${whereClause}
           AND c.workflow_status = 'PROCESSED_BY_MEDICAL'
         ORDER BY c.medical_processed_at DESC, c.id DESC`,
        params
    );
};

module.exports = getProcessedPrescriptionsReport;
