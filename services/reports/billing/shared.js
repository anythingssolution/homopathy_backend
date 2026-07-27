const { buildTimestampDateRangeScope, query } = require('../shared');

const buildBillingReportScope = (filters) => buildTimestampDateRangeScope({
    alias: 'b',
    fromDate: filters.fromDate,
    toDate: filters.toDate,
    branchId: filters.branchId,
});

module.exports = {
    buildBillingReportScope,
    buildTimestampDateRangeScope,
    query,
};
