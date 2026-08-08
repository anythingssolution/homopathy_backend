const { buildBillingReportScope, query } = require('./shared');

const getRevenueByMedicineReport = async (filters) => {
    const { whereClause, params } = buildBillingReportScope(filters);

    return query(
        `SELECT
            bi.item_name AS medicine_name,
            COUNT(DISTINCT bi.bill_id) AS total_bills,
            COALESCE(SUM(bi.quantity), 0) AS total_quantity_sold,
            ROUND(AVG(bi.unit_price), 2) AS average_unit_price,
            COALESCE(SUM(bi.amount), 0) AS gross_revenue
         FROM tbl_bill_items bi
         JOIN tbl_bills b ON b.id = bi.bill_id
         ${whereClause}
           AND b.status = 'ACTIVE'
           AND (UPPER(bi.item_type) LIKE '%MEDIC%' OR (bi.item_type IS NOT NULL AND UPPER(bi.item_type) NOT IN ('TEST')))
         GROUP BY bi.item_name
         ORDER BY gross_revenue DESC, total_quantity_sold DESC`,
        params
    );
};

module.exports = getRevenueByMedicineReport;
