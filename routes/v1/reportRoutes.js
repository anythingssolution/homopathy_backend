const express = require('express');
const {
    getAppointmentReportsController,
    getBookedVsConsultedController,
    getBillingReportsController,
    getRevenueByConsultantController,
    getRevenueByMedicineController,
    getClinicalReportsController,
    getMedicalReportsController,
    getPatientReportsController,
} = require('../../controllers/v1/reports');
const {
    authenticate,
    authorizeRolesOrModuleAccess,
    enforceSelectedBranchScope,
} = require('../../middleware/authMiddleware');

const router = express.Router();

router.use(authenticate, authorizeRolesOrModuleAccess(['doctor', 'receptionist', 'medical'], 'RECEPTION'), enforceSelectedBranchScope);

router.get('/appointments', getAppointmentReportsController);
router.get('/booked-vs-consulted', getBookedVsConsultedController);
router.get('/clinical', getClinicalReportsController);
router.get('/patients', getPatientReportsController);
router.get('/billing', getBillingReportsController);
router.get('/billing/revenue-by-consultant', getRevenueByConsultantController);
router.get('/billing/revenue-by-medicine', getRevenueByMedicineController);
router.get('/medical', getMedicalReportsController);

module.exports = router;
