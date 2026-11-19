const AppError = require('./AppError');

// branchIds is supplied by report authorization, never by a client query string.
const buildReportBranchSql = (column, filters = {}) => {
    if (Array.isArray(filters.branchIds)) {
        const ids = [...new Set(filters.branchIds.map(Number))].filter(id => Number.isSafeInteger(id) && id > 0);
        return ids.length
            ? { sql: `${column} IN (${ids.map(() => '?').join(', ')})`, params: ids }
            : { sql: '1 = 0', params: [] };
    }
    return filters.branchId
        ? { sql: `${column} = ?`, params: [filters.branchId] }
        : { sql: '1 = 1', params: [] };
};

const requireReportBranch = (filters) => {
    if (!Array.isArray(filters.branchIds) && !(Number.isSafeInteger(Number(filters.branchId)) && Number(filters.branchId) > 0)) {
        throw new AppError('Please select a branch', 400);
    }
};

const buildPatientReportMembership = (alias, filters) => {
    const appointment = buildReportBranchSql('membership_a.fk_branch_id', filters);
    const bill = buildReportBranchSql('membership_b.fk_branch_id', filters);
    return {
        sql: `(EXISTS (SELECT 1 FROM tbl_appointments membership_a
            WHERE membership_a.fk_patient_id = ${alias}.id AND membership_a.is_active = 1 AND ${appointment.sql})
            OR EXISTS (SELECT 1 FROM tbl_bills membership_b
            WHERE membership_b.patient_id = ${alias}.id AND ${bill.sql}))`,
        params: [...appointment.params, ...bill.params],
    };
};

module.exports = { buildReportBranchSql, requireReportBranch, buildPatientReportMembership };
