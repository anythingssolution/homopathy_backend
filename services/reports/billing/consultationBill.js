const { buildBillingReportScope, query } = require('./shared');

const getConsultationBillReport = async (filters) => {
    const { whereClause, params } = buildBillingReportScope(filters);

    return query(
        `SELECT
            b.id AS bill_id,
            b.bill_number,
            b.appointment_id,
            b.patient_id,
            COALESCE(fm.full_name, p.full_name) AS patient_full_name,
            p.mobile_no AS patient_mobile_no,
            br.branch_name,
            b.total_amount,
            b.paid_amount,
            b.pending_amount,
            b.payment_status,
            b.payment_settlement_type,
            b.created_at
         FROM tbl_bills b
         LEFT JOIN tbl_appointments a ON a.appointment_id = b.appointment_id
         LEFT JOIN master_users p ON p.id = b.patient_id
         LEFT JOIN tbl_patient_family_members fm ON fm.id = a.fk_patient_family_member_id
         LEFT JOIN master_clinic_branches br ON br.id = b.fk_branch_id
         ${whereClause}
           AND b.status = 'ACTIVE'
           AND b.bill_type = 'CONSULTATION'
         ORDER BY b.created_at DESC, b.id DESC`,
        params
    );
};

module.exports = getConsultationBillReport;
