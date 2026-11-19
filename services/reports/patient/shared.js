const { buildDateRangeScope, buildTimestampDateRangeScope, query } = require('../shared');
const { buildPatientReportMembership } = require('../../../utils/reportBranchSql');

const buildPatientAppointmentScope = (filters) => buildDateRangeScope({
    alias: 'a',
    fromDate: filters.fromDate,
    toDate: filters.toDate,
    branchId: filters.branchId,
    branchIds: filters.branchIds,
});

const buildPatientCreatedScope = (filters) => {
    const scope = buildTimestampDateRangeScope({
        alias: 'p',
        fromDate: filters.fromDate,
        toDate: filters.toDate,
        branchAlias: null,
    });
    return applyPatientReportMembership(scope, filters);
};

const applyPatientReportMembership = (scope, filters) => {
    if (!Array.isArray(filters.branchIds) || filters.allClinicBranches) return scope;
    const membership = buildPatientReportMembership('p', filters);
    return { whereClause: `${scope.whereClause} AND ${membership.sql}`, params: [...scope.params, ...membership.params] };
};

module.exports = {
    buildPatientAppointmentScope,
    buildPatientCreatedScope,
    applyPatientReportMembership,
    query,
};
