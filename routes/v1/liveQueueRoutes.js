const express = require('express');
const {
    authenticate,
    authorizeRolesOrModuleAccess,
    enforceSelectedBranchScope,
    authorizeAppointmentBranchScope,
} = require('../../middleware/authMiddleware');
const {
    getLiveQueue,
    listCurrentDateTokens,
    listReplayEvents,
    startDoctorSession,
    completeDoctorSession,
    checkInAppointment,
    callToken,
    callNextReadyToken,
    startConsultation,
    completeConsultation,
    skipToken,
    reassignToken,
} = require('../../controllers/v1/liveQueueController');

const router = express.Router();

router.get('/current-date-tokens', listCurrentDateTokens);
router.get('/replay/events', listReplayEvents);
router.get('/:slot_id', getLiveQueue);
router.post('/:slot_id/session/start', authenticate, authorizeRolesOrModuleAccess(['doctor'], 'RECEPTION'), enforceSelectedBranchScope, startDoctorSession);
router.post('/:slot_id/session/end', authenticate, authorizeRolesOrModuleAccess(['doctor'], 'RECEPTION'), enforceSelectedBranchScope, completeDoctorSession);
router.post('/:slot_id/call-next', authenticate, authorizeRolesOrModuleAccess(['doctor'], 'RECEPTION'), enforceSelectedBranchScope, callNextReadyToken);
router.post('/appointments/:appointment_id/check-in', authenticate, authorizeRolesOrModuleAccess(['doctor'], 'RECEPTION'), enforceSelectedBranchScope, authorizeAppointmentBranchScope, checkInAppointment);
router.post('/appointments/:appointment_id/call', authenticate, authorizeRolesOrModuleAccess(['doctor'], 'RECEPTION'), enforceSelectedBranchScope, authorizeAppointmentBranchScope, callToken);
router.post('/appointments/:appointment_id/start', authenticate, authorizeRolesOrModuleAccess(['doctor'], 'RECEPTION'), enforceSelectedBranchScope, authorizeAppointmentBranchScope, startConsultation);
router.post('/appointments/:appointment_id/complete', authenticate, authorizeRolesOrModuleAccess(['doctor'], 'RECEPTION'), enforceSelectedBranchScope, authorizeAppointmentBranchScope, completeConsultation);
router.post('/appointments/:appointment_id/skip', authenticate, authorizeRolesOrModuleAccess(['doctor'], 'RECEPTION'), enforceSelectedBranchScope, authorizeAppointmentBranchScope, skipToken);
router.post('/appointments/:appointment_id/reassign', authenticate, authorizeRolesOrModuleAccess(['doctor'], 'RECEPTION'), enforceSelectedBranchScope, authorizeAppointmentBranchScope, reassignToken);

module.exports = router;
