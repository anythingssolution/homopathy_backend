const { buildBillingReportScope, query } = require('./shared');

const getPatientBillingHistoryReport = async (filters) => {
    const { whereClause, params } = buildBillingReportScope(filters);

    return query(
        `SELECT
            b.patient_id,
            COALESCE(fm.full_name, p.full_name) AS patient_full_name,
            p.mobile_no AS patient_mobile_no,
            COUNT(b.id) AS total_bills,
            COALESCE(SUM(b.total_amount), 0) AS total_amount,
            COALESCE(SUM(b.paid_amount), 0) AS paid_amount,
            COALESCE(SUM(b.pending_amount), 0) AS pending_amount,
            MAX(b.created_at) AS last_bill_created_at
         FROM tbl_bills b
         LEFT JOIN tbl_appointments a ON a.appointment_id = b.appointment_id
         LEFT JOIN master_users p ON p.id = b.patient_id
         LEFT JOIN tbl_patient_family_members fm ON fm.id = a.fk_patient_family_member_id
         ${whereClause}
           AND b.status = 'ACTIVE'
         GROUP BY b.patient_id, COALESCE(fm.full_name, p.full_name), p.mobile_no
         ORDER BY total_amount DESC, last_bill_created_at DESC`,
        params
    );
};

module.exports = getPatientBillingHistoryReport;
