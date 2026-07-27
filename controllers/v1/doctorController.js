module.exports = {
    ...require('./doctor/dashboardController'),
    ...require('./doctor/staffAccessController'),
    ...require('./doctor/appointmentsController'),
    ...require('./doctor/consultationController'),
    ...require('./doctor/formulaMasterController'),
    ...require('./doctor/cmsController'),
    ...require('./doctor/cmsUploadController'),
};
