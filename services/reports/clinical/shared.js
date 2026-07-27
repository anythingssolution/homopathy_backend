const { buildDateRangeScope, query } = require('../shared');

const buildClinicalReportScope = (filters) => buildDateRangeScope({
    alias: 'a',
    fromDate: filters.fromDate,
    toDate: filters.toDate,
    branchId: filters.branchId,
});

module.exports = {
    buildClinicalReportScope,
    query,
};
