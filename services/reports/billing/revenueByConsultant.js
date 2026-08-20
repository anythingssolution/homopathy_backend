const { buildBillingReportScope, query } = require('./shared');

const getRevenueByConsultantReport = async (filters) => {
    const { whereClause, params } = buildBillingReportScope(filters);

    const rows = await query(
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
            COALESCE(SUM(b.pending_amount), 0) AS total_pending_revenue,
            CASE 
                WHEN LOWER(s.slot_name) LIKE '%morning%' THEN 'morning'
                WHEN LOWER(s.slot_name) LIKE '%evening%' OR LOWER(s.slot_name) LIKE '%afternoon%' OR LOWER(s.slot_name) LIKE '%night%' THEN 'evening'
                WHEN HOUR(s.start_time) < 12 THEN 'morning'
                ELSE 'evening'
            END AS session_type
         FROM tbl_bills b
         LEFT JOIN tbl_consultations c ON (c.id = b.consultation_id OR c.appointment_id = b.appointment_id)
         LEFT JOIN master_users d ON d.id = c.doctor_id
         LEFT JOIN tbl_appointments a ON a.appointment_id = b.appointment_id
         LEFT JOIN master_slots s ON s.id = a.fk_slot_id
         ${whereClause}
           AND b.status = 'ACTIVE'
           AND c.doctor_id IS NOT NULL
         GROUP BY c.doctor_id, d.full_name, d.uuid, session_type
         ORDER BY total_gross_revenue DESC, doctor_name ASC`,
        params
    );

    return {
        morning: rows.filter((r) => r.session_type === 'morning'),
        evening: rows.filter((r) => r.session_type === 'evening'),
    };
};

module.exports = getRevenueByConsultantReport;
