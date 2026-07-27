const { buildBillingReportScope, query } = require('./shared');

const getPaymentStatusReport = async (filters) => {
    const { whereClause, params } = buildBillingReportScope(filters);

    return query(
        `SELECT
            b.payment_status,
            COUNT(b.id) AS total_bills,
            COALESCE(SUM(b.total_amount), 0) AS total_amount,
            COALESCE(SUM(b.paid_amount), 0) AS paid_amount,
            COALESCE(SUM(b.pending_amount), 0) AS pending_amount
         FROM tbl_bills b
         ${whereClause}
           AND b.status = 'ACTIVE'
         GROUP BY b.payment_status
         ORDER BY FIELD(b.payment_status, 'UNPAID', 'PARTIAL', 'PAID'), b.payment_status ASC`,
        params
    );
};

module.exports = getPaymentStatusReport;
