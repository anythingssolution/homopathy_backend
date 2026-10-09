const express = require('express');
const router = express.Router();
const dispensarySharing = require('../../controllers/v1/dispensaryWhatsAppController');
const { authenticate, authorizeRolesOrModuleAccess, authorizeModuleAccess, enforceSelectedBranchScope, authorizeBillBranchScope } = require('../../middleware/authMiddleware');
const {
    sendWhatsAppMessage,
    sendWhatsAppDocument,
    getWhatsAppHistory,
    getWhatsAppAnalytics,
    getTemplates,
    updatePatientConsent,
    getDoctorSettings,
    updateDoctorSettings,
    getPrescriptionRecipients,
    sharePrescription,
    getScheduledReminders,
    cancelScheduledReminder,
} = require('../../controllers/v1/whatsappController');

// All WhatsApp routes require authentication
router.use(authenticate);

// Role guards allowing Doctor
const staffGuard = authorizeRolesOrModuleAccess(['doctor', 'DOC']);

// Dispensary sharing uses the same module and branch access as Dispensary History.
const dispensaryGuards = [authorizeModuleAccess('MEDICAL'), enforceSelectedBranchScope, authorizeBillBranchScope];
router.post('/dispensary/:bill_id/preview', ...dispensaryGuards, dispensarySharing.preview);
router.post('/dispensary/:bill_id/send', ...dispensaryGuards, dispensarySharing.send);
router.get('/dispensary/:bill_id/messages/:message_id', ...dispensaryGuards, dispensarySharing.status);

// Analytics & Insights
router.get('/analytics', staffGuard, getWhatsAppAnalytics);

// Settings
router.get('/settings', staffGuard, getDoctorSettings);
router.put('/settings', staffGuard, updateDoctorSettings);

// Prescriptions WhatsApp Sharing
router.get('/prescriptions/:consultation_id/recipients', staffGuard, getPrescriptionRecipients);
router.post('/prescriptions/:consultation_id/share', staffGuard, sharePrescription);

// Follow-Up Scheduled Reminders
router.get('/scheduled-reminders', staffGuard, getScheduledReminders);
router.post('/scheduled-reminders/:id/cancel', staffGuard, cancelScheduledReminder);

// Direct Messages & History
router.post('/send', staffGuard, sendWhatsAppMessage);
router.post('/document', staffGuard, sendWhatsAppDocument);
router.get('/history', staffGuard, getWhatsAppHistory);
router.get('/templates', staffGuard, getTemplates);
router.put('/patients/:id/consent', staffGuard, updatePatientConsent);

module.exports = router;
