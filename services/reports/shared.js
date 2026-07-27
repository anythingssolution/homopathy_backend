const { query } = require('../../config/db');

const buildDateRangeScope = ({ alias, column = 'appointment_date', fromDate, toDate, branchAlias = alias, branchId }) => {
    const conditions = [`${alias}.${column} >= ?`, `${alias}.${column} <= ?`];
    const params = [fromDate, toDate];

    if (branchId && branchAlias) {
        conditions.push(`${branchAlias}.fk_branch_id = ?`);
        params.push(branchId);
    }

    return {
        whereClause: `WHERE ${conditions.join(' AND ')}`,
        params,
    };
};

const buildTimestampDateRangeScope = ({ alias, column = 'created_at', fromDate, toDate, branchAlias = alias, branchId }) => {
    const conditions = [`DATE(${alias}.${column}) >= ?`, `DATE(${alias}.${column}) <= ?`];
    const params = [fromDate, toDate];

    if (branchId && branchAlias) {
        conditions.push(`${branchAlias}.fk_branch_id = ?`);
        params.push(branchId);
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
