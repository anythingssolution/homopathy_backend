const { buildDateRangeScope, buildTimestampDateRangeScope, query } = require('../shared');

const buildPatientAppointmentScope = (filters) => buildDateRangeScope({
    alias: 'a',
    fromDate: filters.fromDate,
    toDate: filters.toDate,
    branchId: filters.branchId,
});

const buildPatientCreatedScope = (filters) => buildTimestampDateRangeScope({
    alias: 'p',
    fromDate: filters.fromDate,
    toDate: filters.toDate,
    branchAlias: null,
});

module.exports = {
    buildPatientAppointmentScope,
    buildPatientCreatedScope,
    query,
};
