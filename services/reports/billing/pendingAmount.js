const { buildBillingReportScope, query } = require('./shared');

const SAME_PERSON = `
    ax.fk_patient_id = b.patient_id
    AND ax.is_active = 1
    AND LOWER(COALESCE(ax.status, '')) <> 'cancelled'
    AND ax.fk_patient_family_member_id <=> a.fk_patient_family_member_id
`;

const getPendingAmountReport = async (filters) => {
    const { whereClause, params } = buildBillingReportScope(filters);

    return query(
        `SELECT
            b.id AS bill_id,
            b.bill_number,
            b.bill_type,
            b.patient_id,
            COALESCE(fm.full_name, p.full_name) AS patient_full_name,
            p.mobile_no AS patient_mobile_no,
            br.branch_name,
            b.total_amount,
            b.paid_amount,
            b.pending_amount,
            b.payment_status,
            COALESCE(a.appointment_date, DATE(b.created_at)) AS unpaid_visit_date,
            COALESCE(a.appointment_date, DATE(b.created_at)) AS due_date,
            a.auid,
            b.consultation_id,
            b.appointment_id,
            t.treatment_name,
            d.full_name AS doctor_name,
            b.created_at,
            DATEDIFF(CURDATE(), COALESCE(a.appointment_date, DATE(b.created_at))) AS days_unpaid,
            (
                SELECT COUNT(*)
                FROM tbl_appointments ax
                WHERE ${SAME_PERSON}
            ) AS visit_count,
            (
                SELECT MIN(ax.appointment_date)
                FROM tbl_appointments ax
                WHERE ${SAME_PERSON}
            ) AS first_visit_date,
            (
                SELECT MAX(ax.appointment_date)
                FROM tbl_appointments ax
                WHERE ${SAME_PERSON}
            ) AS last_visit_date,
            (
                SELECT MAX(bp.collected_at)
                FROM tbl_bill_payments bp
                WHERE bp.bill_id = b.id
                  AND bp.status = 'SUCCESS'
            ) AS last_paid_at
         FROM tbl_bills b
         LEFT JOIN tbl_appointments a ON a.appointment_id = b.appointment_id
         LEFT JOIN tbl_consultations c ON c.id = b.consultation_id
         LEFT JOIN master_users d ON d.id = c.doctor_id
         LEFT JOIN master_treatments t ON t.id = a.fk_treatment_id
         LEFT JOIN master_users p ON p.id = b.patient_id
         LEFT JOIN tbl_patient_family_members fm ON fm.id = a.fk_patient_family_member_id
         LEFT JOIN master_clinic_branches br ON br.id = b.fk_branch_id
         ${whereClause}
           AND b.status = 'ACTIVE'
           AND b.pending_amount > 0
         ORDER BY COALESCE(a.appointment_date, DATE(b.created_at)) ASC, b.pending_amount DESC, b.created_at DESC`,
        params
    );
};

module.exports = getPendingAmountReport;
