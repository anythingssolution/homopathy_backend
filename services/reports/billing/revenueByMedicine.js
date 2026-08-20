const { buildBillingReportScope, query } = require('./shared');

const getRevenueByMedicineReport = async (filters) => {
    const { whereClause, params } = buildBillingReportScope(filters);

    const rows = await query(
        `SELECT
            bi.item_name AS medicine_name,
            COUNT(DISTINCT bi.bill_id) AS total_bills,
            COALESCE(SUM(bi.quantity), 0) AS total_quantity_sold,
            ROUND(AVG(bi.unit_price), 2) AS average_unit_price,
            COALESCE(SUM(bi.amount), 0) AS gross_revenue,
            CASE 
                WHEN LOWER(s.slot_name) LIKE '%morning%' THEN 'morning'
                WHEN LOWER(s.slot_name) LIKE '%evening%' OR LOWER(s.slot_name) LIKE '%afternoon%' OR LOWER(s.slot_name) LIKE '%night%' THEN 'evening'
                WHEN HOUR(s.start_time) < 12 THEN 'morning'
                ELSE 'evening'
            END AS session_type
         FROM tbl_bill_items bi
         JOIN tbl_bills b ON b.id = bi.bill_id
         LEFT JOIN tbl_appointments a ON a.appointment_id = b.appointment_id
         LEFT JOIN master_slots s ON s.id = a.fk_slot_id
         ${whereClause}
           AND b.status = 'ACTIVE'
           AND (UPPER(bi.item_type) LIKE '%MEDIC%' OR (bi.item_type IS NOT NULL AND UPPER(bi.item_type) NOT IN ('TEST')))
         GROUP BY bi.item_name, session_type
         ORDER BY gross_revenue DESC, total_quantity_sold DESC`,
        params
    );

    return {
        morning: rows.filter((r) => r.session_type === 'morning'),
        evening: rows.filter((r) => r.session_type === 'evening'),
    };
};

module.exports = getRevenueByMedicineReport;
