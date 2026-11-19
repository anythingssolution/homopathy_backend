const { query } = require('../../config/db');
const { buildReportBranchSql } = require('../../utils/reportBranchSql');

const buildDateRangeScope = ({ alias, column = 'appointment_date', fromDate, toDate, branchAlias = alias, branchId, branchIds }) => {
    const conditions = [`${alias}.${column} >= ?`, `${alias}.${column} <= ?`];
    const params = [fromDate, toDate];

    if (branchAlias && (branchId || Array.isArray(branchIds))) {
        const branch = buildReportBranchSql(`${branchAlias}.fk_branch_id`, { branchId, branchIds });
        conditions.push(branch.sql);
        params.push(...branch.params);
    }

    return {
        whereClause: `WHERE ${conditions.join(' AND ')}`,
        params,
    };
};

const buildTimestampDateRangeScope = ({ alias, column = 'created_at', fromDate, toDate, branchAlias = alias, branchId, branchIds }) => {
    const conditions = [`DATE(${alias}.${column}) >= ?`, `DATE(${alias}.${column}) <= ?`];
    const params = [fromDate, toDate];

    if (branchAlias && (branchId || Array.isArray(branchIds))) {
        const branch = buildReportBranchSql(`${branchAlias}.fk_branch_id`, { branchId, branchIds });
        conditions.push(branch.sql);
        params.push(...branch.params);
    }

    return {
        whereClause: `WHERE ${conditions.join(' AND ')}`,
        params,
    };
};

module.exports = {
    buildDateRangeScope,
    buildTimestampDateRangeScope,
    query,
};
