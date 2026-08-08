const { buildBillingReportScope, query } = require('./shared');

const getRevenueByConsultantReport = async (filters) => {
    const { whereClause, params } = buildBillingReportScope(filters);

    return query(
        `SELECT
            c.doctor_id,
            COALESCE(d.full_name, 'Unassigned Doctor') AS doctor_name,
            d.uuid AS doctor_uuid,
            COUNT(DISTINCT b.id) AS total_bills,
            COUNT(DISTINCT c.id) AS total_consultations,
            COALESCE(SUM(CASE WHEN b.bill_type = 'CONSULTATION' THEN b.total_amount ELSE 0 END), 0) AS consultation_revenue,
            COALESCE(SUM(CASE WHEN b.bill_type = 'CONSULTATION' THEN b.paid_amount ELSE 0 END), 0) AS consultation_paid,
            COALESCE(SUM(CASE WHEN b.bill_type = 'MEDICATION' THEN b.total_amount ELSE 0 END), 0) AS medication_revenue,
            COALESCE(SUM(CASE WHEN b.bill_type = 'MEDICATION' THEN b.paid_amount ELSE 0 END), 0) AS medication_paid,
            COALESCE(SUM(b.total_amount), 0) AS total_gross_revenue,
            COALESCE(SUM(b.paid_amount), 0) AS total_paid_revenue,
            COALESCE(SUM(b.pending_amount), 0) AS total_pending_revenue
         FROM tbl_bills b
         LEFT JOIN tbl_consultations c ON (c.id = b.consultation_id OR c.appointment_id = b.appointment_id)
         LEFT JOIN master_users d ON d.id = c.doctor_id
         ${whereClause}
           AND b.status = 'ACTIVE'
           AND c.doctor_id IS NOT NULL
         GROUP BY c.doctor_id, d.full_name, d.uuid
         ORDER BY total_gross_revenue DESC, doctor_name ASC`,
        params
    );
};

module.exports = getRevenueByConsultantReport;
