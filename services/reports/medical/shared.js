const { buildDateRangeScope, query } = require('../shared');

const buildMedicalReportScope = (filters) => buildDateRangeScope({
    alias: 'a',
    fromDate: filters.fromDate,
    toDate: filters.toDate,
    branchId: filters.branchId,
});

module.exports = {
    buildMedicalReportScope,
    query,
};
