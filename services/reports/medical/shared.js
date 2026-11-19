const { buildDateRangeScope, query } = require('../shared');

const buildMedicalReportScope = (filters) => buildDateRangeScope({
    alias: 'a',
    fromDate: filters.fromDate,
    toDate: filters.toDate,
    branchId: filters.branchId,
    branchIds: filters.branchIds,
});

module.exports = {
    buildMedicalReportScope,
    query,
};
