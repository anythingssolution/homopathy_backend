const { buildBillingReportScope, query } = require('./shared');

const getTotalRevenueReport = async (filters) => {
    const { appointmentJoin, whereClause, params } = buildBillingReportScope(filters);

    return query(
        `SELECT
            COUNT(b.id) AS total_bills,
            SUM(CASE WHEN b.paid_amount > 0 THEN 1 ELSE 0 END) AS paid_or_partial_bills,
            SUM(CASE WHEN b.paid_amount <= 0 THEN 1 ELSE 0 END) AS unpaid_bills,
            COALESCE(SUM(b.total_amount), 0) AS total_amount,
            COALESCE(SUM(b.paid_amount), 0) AS paid_amount,
            COALESCE(SUM(b.pending_amount), 0) AS pending_amount,
            COALESCE(SUM(CASE WHEN b.paid_amount <= 0 THEN b.pending_amount ELSE 0 END), 0) AS unpaid_amount
         FROM tbl_bills b
         ${appointmentJoin}
         ${whereClause}
           AND b.status = 'ACTIVE'`,
        params
    );
};

module.exports = getTotalRevenueReport;
