const { buildClinicalReportScope, query } = require('./shared');

const getRepeatTreatmentChainReport = async (filters) => {
    const { whereClause, params } = buildClinicalReportScope(filters);

    return query(
        `SELECT
            c.id AS consultation_id,
            c.repeated_from_consultation_id,
            c.appointment_id,
            a.parent_appointment_id,
            a.appointment_date,
            COALESCE(fm.full_name, p.full_name) AS patient_full_name,
            p.mobile_no AS patient_mobile_no,
            b.branch_name,
            t.treatment_name,
            c.medication_duration_days,
            c.follow_up_after_days,
            c.follow_up_chain_closed,
            c.workflow_status
         FROM tbl_consultations c
         JOIN tbl_appointments a ON a.appointment_id = c.appointment_id
         JOIN master_users p ON p.id = a.fk_patient_id
         LEFT JOIN tbl_patient_family_members fm ON fm.id = a.fk_patient_family_member_id
         JOIN master_clinic_branches b ON b.id = a.fk_branch_id
         JOIN master_treatments t ON t.id = a.fk_treatment_id
         ${whereClause}
           AND (c.repeated_from_consultation_id IS NOT NULL OR a.parent_appointment_id IS NOT NULL)
         ORDER BY a.appointment_date DESC, c.id DESC`,
        params
    );
};

module.exports = getRepeatTreatmentChainReport;
