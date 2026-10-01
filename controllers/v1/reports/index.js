module.exports = {
    ...require('./appointmentReportController'),
    ...require('./clinicalReportController'),
    ...require('./patientReportController'),
    ...require('./billingReportController'),
    ...require('./medicalReportController'),
    ...require('./testRegisterReportController'),
    ...require('./courierRegisterReportController'),
};
