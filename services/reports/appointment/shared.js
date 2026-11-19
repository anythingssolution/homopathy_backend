const { buildDateRangeScope, query } = require('../shared');

const buildAppointmentReportScope = (filters) => buildDateRangeScope({
    alias: 'a',
    fromDate: filters.fromDate,
    toDate: filters.toDate,
    branchId: filters.branchId,
    branchIds: filters.branchIds,
});

module.exports = {
    buildAppointmentReportScope,
    query,
};
