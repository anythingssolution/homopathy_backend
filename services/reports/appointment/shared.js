const { buildDateRangeScope, query } = require('../shared');

const buildAppointmentReportScope = (filters) => buildDateRangeScope({
    alias: 'a',
    fromDate: filters.fromDate,
    toDate: filters.toDate,
    branchId: filters.branchId,
});

module.exports = {
    buildAppointmentReportScope,
    query,
};
