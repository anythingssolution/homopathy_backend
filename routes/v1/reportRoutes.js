const express = require('express');
const {
    getAppointmentReportsController,
    getAppointmentListController,
    getBookedVsConsultedController,
    getBillingReportsController,
    getRevenueByConsultantController,
    getRevenueByMedicineController,
    getClinicalReportsController,
    getMedicalReportsController,
    getTestRegisterReportController,
    updateTestReportSendStatusController,
    getCourierRegisterReportController,
    getPatientReportsController,
    getLocationPatientReportController,
    getNotReturnedReportController,
    getDispensaryRegisterController,
} = require('../../controllers/v1/reports');
const {
    authenticate,
    authorizeRoles,
    authorizeRolesOrModuleAccess,
    enforceSelectedBranchScope,
} = require('../../middleware/authMiddleware');

const router = express.Router();

router.use(authenticate, authorizeRolesOrModuleAccess(['doctor', 'receptionist', 'medical'], 'RECEPTION'), enforceSelectedBranchScope);

router.get('/appointments', getAppointmentReportsController);
router.get('/appointments/list', authorizeRoles('doctor'), getAppointmentListController);
router.get('/booked-vs-consulted', getBookedVsConsultedController);
router.get('/clinical', getClinicalReportsController);
router.get('/patients', getPatientReportsController);
router.get('/location-patients', authorizeRoles('doctor'), getLocationPatientReportController);
router.get('/not-returned', authorizeRoles('doctor'), getNotReturnedReportController);
router.get('/billing', getBillingReportsController);
router.get('/billing/revenue-by-consultant', getRevenueByConsultantController);
router.get('/billing/revenue-by-medicine', getRevenueByMedicineController);
router.get('/medical', getMedicalReportsController);
router.get('/dispensary', authorizeRoles('doctor'), getDispensaryRegisterController);
router.get('/test-register', getTestRegisterReportController);
router.put('/test-register/report-status', updateTestReportSendStatusController);
router.get('/courier-register', getCourierRegisterReportController);

module.exports = router;
