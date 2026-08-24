const { query } = require('../shared');

const APPOINTMENT_JOIN = 'LEFT JOIN tbl_appointments a ON a.appointment_id = b.appointment_id';

const buildBillingReportScope = (filters) => {
    const conditions = [
        `COALESCE(a.appointment_date, DATE(b.created_at)) >= ?`,
        `COALESCE(a.appointment_date, DATE(b.created_at)) <= ?`
    ];
    const params = [filters.fromDate, filters.toDate];

    if (filters.branchId) {
        conditions.push(`b.fk_branch_id = ?`);
        params.push(filters.branchId);
    }

    return {
        appointmentJoin: APPOINTMENT_JOIN,
        whereClause: `WHERE ${conditions.join(' AND ')}`,
        params,
    };
};

module.exports = {
    buildBillingReportScope,
    query,
};
