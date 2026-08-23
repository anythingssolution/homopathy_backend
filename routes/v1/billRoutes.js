const express = require('express');
const {
    createConsultationBill,
    collectConsultationPayment,
    collectMedicationPayment,
    collectPatientDues,
    createMedicationBill,
    listBills,
    getBillById,
    getAppointmentBillingSummary,
    getPatientOutstanding,
} = require('../../controllers/v1/billController');
const {
    authenticate,
    authorizeRoles,
    authorizeModuleAccess,
    authorizeRolesOrModuleAccess,
    enforceSelectedBranchScope,
    authorizeBillBranchScope,
    authorizeAppointmentBranchScope,
} = require('../../middleware/authMiddleware');

const router = express.Router();

router.post('/consultation', authenticate, authorizeRolesOrModuleAccess(['patient'], 'RECEPTION'), enforceSelectedBranchScope, createConsultationBill);
router.patch('/consultation/:bill_id/collect-payment', authenticate, authorizeModuleAccess('RECEPTION'), enforceSelectedBranchScope, authorizeBillBranchScope, collectConsultationPayment);
router.post('/medication', authenticate, authorizeModuleAccess('MEDICAL'), enforceSelectedBranchScope, createMedicationBill);
router.patch('/medication/:bill_id/collect-payment', authenticate, authorizeModuleAccess('MEDICAL'), enforceSelectedBranchScope, authorizeBillBranchScope, collectMedicationPayment);
router.get('/patients/:patient_id/outstanding', authenticate, authorizeRoles('patient', 'doctor', 'receptionist', 'medical'), enforceSelectedBranchScope, getPatientOutstanding);
router.post('/patients/:patient_id/collect-dues', authenticate, authorizeModuleAccess('MEDICAL'), enforceSelectedBranchScope, collectPatientDues);
router.get('/', authenticate, authorizeRoles('patient', 'doctor', 'receptionist', 'medical'), enforceSelectedBranchScope, listBills);
router.get('/appointment/:appointment_id/summary', authenticate, authorizeRoles('doctor'), enforceSelectedBranchScope, authorizeAppointmentBranchScope, getAppointmentBillingSummary);
router.get('/:bill_id', authenticate, authorizeRoles('patient', 'doctor', 'receptionist', 'medical'), enforceSelectedBranchScope, authorizeBillBranchScope, getBillById);

module.exports = router;
