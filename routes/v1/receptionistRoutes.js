const express = require('express');
const {
    createAppointmentByReceptionist,
    listReceptionistAppointments,
    approveReceptionistAppointment,
    rejectReceptionistAppointment,
    getReceptionistFormData,
    listReceptionistPatients,
    getReceptionistPatientDetail,
    updateReceptionistPatient,
    listReceptionistPatientUpdateHistory,
    createReceptionistPatientFamilyMember,
    saveReceptionistAppointmentVitals,
    markAppointmentNotAvailable,
    rescheduleAppointmentByReceptionist,
    listReceptionistPrescriptions,
    getReceptionistPrescriptionDetail,
    getBranchTokenLayout,
    updateBranchTokenLayout,
    getBranchExtensionTokenLayout,
    updateBranchExtensionTokenLayout,
    bulkRejectReceptionistAppointments,
    transferAppointmentByReceptionist,
} = require('../../controllers/v1/receptionistController');
const { getBookingTokenPlate } = require('../../controllers/v1/appointmentController');
const {
    getExtensionPreview,
    createExtension,
    listExtensions,
    getExtensionDetail,
    cancelExtension,
} = require('../../controllers/v1/slotTokenExtensionController');
const {
    startSessionByReceptionist,
    pauseSessionByReceptionist,
    getSessionStatusForReceptionist,
} = require('../../controllers/v1/doctorSessionController');
const {
    authenticate,
    authorizeRolesOrModuleAccess,
    enforceSelectedBranchScope,
    authorizeAppointmentBranchScope,
    authorizeConsultationBranchScope,
} = require('../../middleware/authMiddleware');

const router = express.Router();

router.use(authenticate, authorizeRolesOrModuleAccess(['doctor'], 'RECEPTION'), enforceSelectedBranchScope);

router.post('/book-appointment', createAppointmentByReceptionist);
router.get('/form-data', getReceptionistFormData);
router.get('/token-plate', getBookingTokenPlate);
router.get('/appointments', listReceptionistAppointments);
router.get('/session/status', getSessionStatusForReceptionist);
router.post('/session/start', startSessionByReceptionist);
router.post('/session/pause', pauseSessionByReceptionist);
router.post('/appointments/:appointment_id/approve-and-collect-payment', authorizeAppointmentBranchScope, approveReceptionistAppointment);
router.post('/appointments/:appointment_id/approve', authorizeAppointmentBranchScope, approveReceptionistAppointment);
router.post('/appointments/:appointment_id/reject', authorizeAppointmentBranchScope, rejectReceptionistAppointment);
router.post('/appointments/bulk-reject', bulkRejectReceptionistAppointments);
router.put('/appointments/:appointment_id/vitals', authorizeAppointmentBranchScope, saveReceptionistAppointmentVitals);
router.get('/patients', listReceptionistPatients);
router.get('/patients/:patient_id', getReceptionistPatientDetail);
router.patch('/patients/:patient_id', updateReceptionistPatient);
router.get('/patients/:patient_id/update-history', listReceptionistPatientUpdateHistory);
router.post('/patients/:patient_id/family-members', createReceptionistPatientFamilyMember);
router.post('/appointments/:appointment_id/not-available', authorizeAppointmentBranchScope, markAppointmentNotAvailable);
router.post('/appointments/:appointment_id/reschedule', authorizeAppointmentBranchScope, rescheduleAppointmentByReceptionist);
router.post('/appointments/:appointment_id/transfer', authorizeAppointmentBranchScope, transferAppointmentByReceptionist);
router.get('/prescriptions', listReceptionistPrescriptions);
router.get('/prescriptions/:consultation_id', authorizeConsultationBranchScope, getReceptionistPrescriptionDetail);
router.get('/token-layout', getBranchTokenLayout);
router.post('/token-layout', updateBranchTokenLayout);
router.get('/extra-token-layout', getBranchExtensionTokenLayout);
router.post('/extra-token-layout', updateBranchExtensionTokenLayout);
router.get('/token-extensions/preview', getExtensionPreview);
router.get('/token-extensions', listExtensions);
router.post('/token-extensions', createExtension);
router.get('/token-extensions/:extension_id', getExtensionDetail);
router.post('/token-extensions/:extension_id/cancel', cancelExtension);

module.exports = router;
