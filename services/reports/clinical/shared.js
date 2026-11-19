const { buildDateRangeScope, query } = require('../shared');

const buildClinicalReportScope = (filters) => buildDateRangeScope({
    alias: 'a',
    fromDate: filters.fromDate,
    toDate: filters.toDate,
    branchId: filters.branchId,
    branchIds: filters.branchIds,
});

module.exports = {
    buildClinicalReportScope,
    query,
};
