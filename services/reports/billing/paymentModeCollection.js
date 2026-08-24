const { buildBillingReportScope, query } = require('./shared');

const getPaymentModeCollectionReport = async (filters) => {
    const { appointmentJoin, whereClause, params } = buildBillingReportScope(filters);
    const scopedBills = `SELECT b.id, b.bill_type, b.paid_amount
         FROM tbl_bills b
         ${appointmentJoin}
         ${whereClause}
           AND b.status = 'ACTIVE'`;

    return query(
        `SELECT
            modes.payment_mode,
            bill_types.payment_for,
            COUNT(DISTINCT bp.bill_id) AS total_payments,
            COALESCE(SUM(bp.amount), 0) AS collected_amount
         FROM (
            SELECT 'CASH' AS payment_mode
            UNION ALL
            SELECT 'ONLINE' AS payment_mode
         ) modes
         CROSS JOIN (
            SELECT DISTINCT scoped.bill_type AS payment_for
            FROM (${scopedBills}) scoped
         ) bill_types
         LEFT JOIN (${scopedBills}) paid_bills
           ON paid_bills.bill_type = bill_types.payment_for
          AND paid_bills.paid_amount > 0
         LEFT JOIN tbl_bill_payments bp
           ON bp.bill_id = paid_bills.id
          AND bp.status = 'SUCCESS'
          AND bp.payment_mode = modes.payment_mode
         GROUP BY modes.payment_mode, bill_types.payment_for
         ORDER BY bill_types.payment_for ASC, FIELD(modes.payment_mode, 'CASH', 'ONLINE')`,
        [...params, ...params]
    );
};

module.exports = getPaymentModeCollectionReport;
