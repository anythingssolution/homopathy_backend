const { buildScopedBillingReportCte, query } = require('./shared');

const getDiscountSummaryReport = async (filters) => {
    const { cte, params } = buildScopedBillingReportCte(filters);
    return query(
        `${cte}
         SELECT d.discount_category,
                d.reason_code,
                COUNT(*) AS discount_count,
                COALESCE(SUM(d.discount_amount), 0) AS discount_amount
         FROM tbl_bill_discounts d
         JOIN scoped_bills b ON b.id = d.bill_id
         WHERE d.status = 'ACTIVE'
         GROUP BY d.discount_category, d.reason_code
         ORDER BY discount_amount DESC, d.discount_category ASC, d.reason_code ASC`,
        params
    );
};

module.exports = getDiscountSummaryReport;
