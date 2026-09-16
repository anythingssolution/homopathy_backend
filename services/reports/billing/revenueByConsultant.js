const { buildScopedBillingReportCte, query } = require('./shared');

const SESSION_TYPE_SQL = `CASE
    WHEN LOWER(s.slot_name) LIKE '%morning%' THEN 'morning'
    WHEN LOWER(s.slot_name) LIKE '%evening%' OR LOWER(s.slot_name) LIKE '%afternoon%' OR LOWER(s.slot_name) LIKE '%night%' THEN 'evening'
    WHEN HOUR(s.start_time) < 12 THEN 'morning'
    ELSE 'evening'
END`;

const getRevenueByConsultantReport = async (filters) => {
    const { cte, params } = buildScopedBillingReportCte(filters);

    const revenuePromise = query(
        `${cte}
         SELECT
            c.doctor_id,
            COALESCE(d.full_name, 'Unassigned Doctor') AS doctor_name,
            d.uuid AS doctor_uuid,
            COALESCE(bp.payment_mode, 'UNPAID') AS payment_mode,
            COUNT(DISTINCT b.id) AS total_bills,
            COUNT(DISTINCT c.id) AS total_consultations,
            COALESCE(SUM(CASE WHEN b.bill_type = 'CONSULTATION' THEN b.total_amount ELSE 0 END), 0) AS consultation_revenue,
            COALESCE(SUM(CASE WHEN b.bill_type = 'CONSULTATION' THEN b.paid_amount ELSE 0 END), 0) AS consultation_paid,
            COALESCE(SUM(CASE
                WHEN b.bill_type = 'MEDICATION' AND bi.bill_id IS NULL THEN b.total_amount
                WHEN b.bill_type = 'MEDICATION' AND COALESCE(b.delivery_mode, 'HAND_DELIVERY') <> 'COURIER' THEN bi.medication_revenue
                ELSE 0
            END), 0) AS medication_revenue,
            COALESCE(SUM(CASE WHEN b.bill_type = 'MEDICATION' THEN COALESCE(bi.test_lab_revenue, 0) ELSE 0 END), 0) AS test_lab_revenue,
            COALESCE(SUM(CASE WHEN b.bill_type = 'MEDICATION' AND COALESCE(b.delivery_mode, 'HAND_DELIVERY') = 'COURIER' THEN COALESCE(bi.medication_revenue, 0) ELSE 0 END), 0) AS courier_medicine_revenue,
            COALESCE(SUM(CASE WHEN b.bill_type = 'MEDICATION' AND COALESCE(b.delivery_mode, 'HAND_DELIVERY') = 'COURIER' THEN COALESCE(bi.courier_charge_revenue, 0) ELSE 0 END), 0) AS courier_charge_revenue,
            COALESCE(SUM(CASE
                WHEN b.bill_type = 'MEDICATION' AND COALESCE(b.delivery_mode, 'HAND_DELIVERY') = 'COURIER'
                THEN COALESCE(bi.medication_revenue, 0) + COALESCE(bi.courier_charge_revenue, 0)
                ELSE 0
            END), 0) AS courier_revenue,
            COALESCE(SUM(CASE WHEN b.bill_type = 'MEDICATION' THEN b.paid_amount ELSE 0 END), 0) AS medication_paid,
            COALESCE(SUM(b.total_amount), 0) AS total_gross_revenue,
            COALESCE(SUM(b.paid_amount), 0) AS total_paid_revenue,
            COALESCE(SUM(b.pending_amount), 0) AS total_pending_revenue,
            ${SESSION_TYPE_SQL} AS session_type
         FROM scoped_bills b
         LEFT JOIN (
            SELECT
                bill_id,
                CASE
                    WHEN COUNT(DISTINCT UPPER(payment_mode)) > 1 THEN 'MIXED'
                    ELSE MAX(UPPER(payment_mode))
                END AS payment_mode
            FROM tbl_bill_payments
            JOIN scoped_bills payment_bill ON payment_bill.id = tbl_bill_payments.bill_id
            WHERE tbl_bill_payments.status = 'SUCCESS'
            GROUP BY bill_id
         ) bp ON bp.bill_id = b.id
         LEFT JOIN (
            SELECT
                bill_id,
                COALESCE(SUM(CASE WHEN UPPER(item_type) = 'TEST' THEN amount ELSE 0 END), 0) AS test_lab_revenue,
                COALESCE(SUM(CASE WHEN LOWER(COALESCE(item_name, '')) = 'courier charge' THEN amount ELSE 0 END), 0) AS courier_charge_revenue,
                COALESCE(SUM(CASE
                    WHEN (UPPER(item_type) <> 'TEST' OR item_type IS NULL)
                     AND LOWER(COALESCE(item_name, '')) <> 'courier charge' THEN amount
                    ELSE 0
                END), 0) AS medication_revenue
            FROM tbl_bill_items
            JOIN scoped_bills item_bill ON item_bill.id = tbl_bill_items.bill_id
            GROUP BY bill_id
         ) bi ON bi.bill_id = b.id
         LEFT JOIN tbl_consultations c ON (c.id = b.consultation_id OR c.appointment_id = b.appointment_id)
         LEFT JOIN master_users d ON d.id = c.doctor_id
         LEFT JOIN tbl_appointments a ON a.appointment_id = b.appointment_id
         LEFT JOIN tbl_appointments session_a ON session_a.appointment_id = COALESCE(b.appointment_id, c.appointment_id)
         LEFT JOIN master_slots s ON s.id = session_a.fk_slot_id
         ${filters.includeUnassigned ? '' : 'WHERE c.doctor_id IS NOT NULL'}
         GROUP BY c.doctor_id, d.full_name, d.uuid, payment_mode, session_type
         ORDER BY total_gross_revenue DESC, doctor_name ASC`,
        params
    );

    // A consultation may have bills in different payment-mode groups. Counting
    // its ID once here prevents the UI from adding it once per payment group.
    const countsPromise = filters.includeConsultationCounts ? query(
        `${cte}
         SELECT c.doctor_id,
            COUNT(DISTINCT c.id) AS total_consultations,
            COUNT(DISTINCT CASE WHEN (${SESSION_TYPE_SQL}) = 'morning' THEN c.id END) AS morning_consultations,
            COUNT(DISTINCT CASE WHEN (${SESSION_TYPE_SQL}) = 'evening' THEN c.id END) AS evening_consultations
         FROM scoped_bills b
         LEFT JOIN tbl_consultations c ON (c.id = b.consultation_id OR c.appointment_id = b.appointment_id)
         LEFT JOIN tbl_appointments session_a ON session_a.appointment_id = COALESCE(b.appointment_id, c.appointment_id)
         LEFT JOIN master_slots s ON s.id = session_a.fk_slot_id
         ${filters.includeUnassigned ? '' : 'WHERE c.doctor_id IS NOT NULL'}
         GROUP BY c.doctor_id`,
        params
    ) : Promise.resolve(null);
    const [rows, counts] = await Promise.all([revenuePromise, countsPromise]);

    return {
        morning: rows.filter((r) => r.session_type === 'morning'),
        evening: rows.filter((r) => r.session_type === 'evening'),
        ...(counts === null ? {} : { consultation_counts: counts }),
    };
};

module.exports = getRevenueByConsultantReport;
