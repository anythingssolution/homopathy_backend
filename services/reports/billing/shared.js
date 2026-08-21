const { query } = require('../shared');

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
        whereClause: `WHERE ${conditions.join(' AND ')}`,
        params,
    };
};

module.exports = {
    buildBillingReportScope,
    query,
};
