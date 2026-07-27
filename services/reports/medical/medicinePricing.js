const { buildMedicalReportScope, query } = require('./shared');

const getMedicinePricingReport = async (filters) => {
    const { whereClause, params } = buildMedicalReportScope(filters);

    return query(
        `SELECT
            mpp.id AS pricing_id,
            mpp.consultation_id,
            c.appointment_id,
            a.appointment_date,
            COALESCE(fm.full_name, p.full_name) AS patient_full_name,
            p.mobile_no AS patient_mobile_no,
            b.branch_name,
            mpp.total_amount,
            mpp.remark,
            created_by.full_name AS created_by_name,
            mpp.created_at,
            COUNT(mppi.id) AS total_priced_items
         FROM tbl_medical_prescription_pricing mpp
         JOIN tbl_consultations c ON c.id = mpp.consultation_id
         JOIN tbl_appointments a ON a.appointment_id = c.appointment_id
         JOIN master_users p ON p.id = a.fk_patient_id
         LEFT JOIN tbl_patient_family_members fm ON fm.id = a.fk_patient_family_member_id
         JOIN master_clinic_branches b ON b.id = a.fk_branch_id
         LEFT JOIN master_users created_by ON created_by.id = mpp.created_by
         LEFT JOIN tbl_medical_prescription_pricing_items mppi ON mppi.pricing_id = mpp.id
         ${whereClause}
         GROUP BY mpp.id, mpp.consultation_id, c.appointment_id, a.appointment_date, COALESCE(fm.full_name, p.full_name), p.mobile_no, b.branch_name, mpp.total_amount, mpp.remark, created_by.full_name, mpp.created_at
         ORDER BY mpp.created_at DESC, mpp.id DESC`,
        params
    );
};

module.exports = getMedicinePricingReport;
