const { buildBillingReportScope, query } = require('./shared');

const getBranchWiseRevenueReport = async (filters) => {
    const { whereClause, params } = buildBillingReportScope(filters);

    return query(
        `SELECT
            br.id AS branch_id,
            br.branch_name,
            COUNT(b.id) AS total_bills,
            COALESCE(SUM(b.total_amount), 0) AS total_amount,
            COALESCE(SUM(b.paid_amount), 0) AS paid_amount,
            COALESCE(SUM(b.pending_amount), 0) AS pending_amount
         FROM tbl_bills b
         JOIN master_clinic_branches br ON br.id = b.fk_branch_id
         ${whereClause}
           AND b.status = 'ACTIVE'
         GROUP BY br.id, br.branch_name
         ORDER BY paid_amount DESC, br.branch_name ASC`,
        params
    );
};

module.exports = getBranchWiseRevenueReport;
