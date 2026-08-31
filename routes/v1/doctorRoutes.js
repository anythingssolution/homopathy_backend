const express = require('express');
const {
    getDoctorDashboard,
    listPatientsForDoctor,
    getDoctorReports,
    getDoctorTextMedicineMasters,
    listDoctorFormulaSets,
    getDoctorFormulaSet,
    getDoctorFormulaBootstrap,
    createDoctorFormulaSet,
    updateDoctorFormulaSet,
    activateDoctorFormulaSet,
    removeDoctorFormulaSet,
    previewDoctorFormulaParse,
    listDoctorStaffAccess,
    updateDoctorStaffAccess,
    listAppointmentsForDoctor,
    listConsultationHistoryForDoctor,
    listBilledPrescriptionsForDoctor,
    getAppointmentDetailForDoctor,
    createConsultation,
    getConsultationByAppointmentId,
    saveConsultationTestFindings,
    getRepeatTreatmentDraft,
    getPrescriptionSuggestions,
    getDoctorHomepageCms,
    listHeroCms,
    createHeroCms,
    updateHeroCms,
    deleteHeroCms,
    listTestimonialsCms,
    createTestimonialsCms,
    updateTestimonialsCms,
    deleteTestimonialsCms,
    listGalleryCms,
    createGalleryCms,
    updateGalleryCms,
    deleteGalleryCms,
    uploadDoctorCmsImage,
    uploadDoctorCmsVideo,
    updateDoctorPatient,
} = require('../../controllers/v1/doctorController');
const {
    uploadCmsImageFile,
    uploadCmsVideoFiles,
} = require('../../middleware/cmsUploadMiddleware');
const {
    getOwnSessionStatus,
    startSession,
    startBreak,
    resumeBreak,
    pauseSession,
    listSessionLogs,
} = require('../../controllers/v1/doctorSessionController');
const {
    listDoctorLeaves,
    saveDoctorLeave,
    removeDoctorLeave,
    saveDoctorLeavesBulk,
    removeDoctorLeavesBulk,
} = require('../../controllers/v1/doctorLeaveController');
const {
    listSlotTimings,
    saveSlotTiming,
    resetSlotTiming,
} = require('../../controllers/v1/doctorSlotTimeOverrideController');
const {
    authenticate,
    authorizeRoles,
    enforceSelectedBranchScope,
    authorizeAppointmentBranchScope,
} = require('../../middleware/authMiddleware');

const router = express.Router();

router.use(authenticate, authorizeRoles('doctor'), enforceSelectedBranchScope);

router.get('/dashboard', getDoctorDashboard);
router.get('/patient', listPatientsForDoctor);
router.get('/reports', getDoctorReports);
router.get('/masters/text-medicines', getDoctorTextMedicineMasters);
router.get('/formula-master/bootstrap', getDoctorFormulaBootstrap);
router.post('/formula-master/preview-parse', previewDoctorFormulaParse);
router.get('/formula-master', listDoctorFormulaSets);
router.post('/formula-master', createDoctorFormulaSet);
router.get('/formula-master/:set_id', getDoctorFormulaSet);
router.put('/formula-master/:set_id', updateDoctorFormulaSet);
router.delete('/formula-master/:set_id', removeDoctorFormulaSet);
router.post('/formula-master/:set_id/activate', activateDoctorFormulaSet);
router.get('/cms/homepage', getDoctorHomepageCms);
router.post('/cms/uploads/image', uploadCmsImageFile, uploadDoctorCmsImage);
router.post('/cms/uploads/video', uploadCmsVideoFiles, uploadDoctorCmsVideo);
router.get('/cms/hero', listHeroCms);
router.post('/cms/hero', createHeroCms);
router.put('/cms/hero/:id', updateHeroCms);
router.delete('/cms/hero/:id', deleteHeroCms);
router.get('/cms/testimonials', listTestimonialsCms);
router.post('/cms/testimonials', createTestimonialsCms);
router.put('/cms/testimonials/:id', updateTestimonialsCms);
router.delete('/cms/testimonials/:id', deleteTestimonialsCms);
router.get('/cms/gallery', listGalleryCms);
router.post('/cms/gallery', createGalleryCms);
router.put('/cms/gallery/:id', updateGalleryCms);
router.delete('/cms/gallery/:id', deleteGalleryCms);
router.get('/staff-access', listDoctorStaffAccess);
router.put('/staff-access', updateDoctorStaffAccess);
router.get('/appointments', listAppointmentsForDoctor);
router.get('/appointments/:appointment_id', authorizeAppointmentBranchScope, getAppointmentDetailForDoctor);
router.get('/consultations-history', listConsultationHistoryForDoctor);
router.get('/billed-prescriptions', listBilledPrescriptionsForDoctor);
router.get('/session/status', getOwnSessionStatus);
router.post('/session/start', startSession);
router.post('/session/break', startBreak);
router.post('/session/resume-break', resumeBreak);
router.post('/session/pause', pauseSession);
router.get('/session/logs', listSessionLogs);
router.get('/leaves', listDoctorLeaves);
router.get('/slot-time-overrides', listSlotTimings);
router.put('/slot-time-overrides', saveSlotTiming);
router.post('/slot-time-overrides/reset', resetSlotTiming);
router.post('/leaves/bulk', saveDoctorLeavesBulk);
router.post('/leaves/bulk-cancel', removeDoctorLeavesBulk);
router.post('/leaves', saveDoctorLeave);
router.delete('/leaves/:leave_id', removeDoctorLeave);
router.patch('/patients/:patient_id', updateDoctorPatient);
router.post('/consultations', createConsultation);
router.get('/consultations/:appointment_id/repeat-draft', authorizeAppointmentBranchScope, getRepeatTreatmentDraft);
router.put('/consultations/:appointment_id/test-findings', authorizeAppointmentBranchScope, saveConsultationTestFindings);
router.get('/consultations/prescription-suggestions', getPrescriptionSuggestions);
router.get('/consultations/:appointment_id', authorizeAppointmentBranchScope, getConsultationByAppointmentId);

module.exports = router;
