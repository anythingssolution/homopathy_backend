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
} = require('../../middleware/authMiddleware');
const { enforceReportBranchScope, authorizeReportEntity } = require('../../middleware/reportBranchScope');

const router = express.Router();

router.use(authenticate, authorizeRolesOrModuleAccess(['doctor', 'receptionist', 'medical'], 'RECEPTION'), enforceReportBranchScope);

router.get('/branches', (req, res) => res.json({ success: true, data: { branches: req.reportScope?.availableBranches || [] } }));
router.get('/prescriptions/:appointment_id', authorizeRoles('doctor'), authorizeReportEntity('appointment'), require('../../controllers/v1/reports/prescriptionReportController').getReportPrescription);
router.get('/medical-prescriptions/:consultation_id', authorizeRoles('doctor'), authorizeReportEntity('consultation'), require('../../controllers/v1/medicalController').getMedicalPrescription);
router.get('/bills/:bill_id', authorizeRoles('doctor'), authorizeReportEntity('bill'), (req, res, next) => {
    req.query.billing_scope = 'branch';
    return require('../../controllers/v1/billController').getBillById(req, res, next);
});

router.get('/appointments', getAppointmentReportsController);
router.get('/appointments/list', authorizeRoles('doctor'), getAppointmentListController);
router.get('/booked-vs-consulted', getBookedVsConsultedController);
router.get('/clinical', getClinicalReportsController);
router.get('/patients', getPatientReportsController);
router.get('/location-patients', authorizeRoles('doctor'), getLocationPatientReportController);
router.get('/patient-sources', authorizeRoles('doctor'), require('../../controllers/v1/patientDiscoverySourceController').getSourceReport);
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
