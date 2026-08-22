const express = require('express');
const {
    createPreviousManualPatient,
    listPreviousManualPatients,
    updatePreviousManualPatient,
    getPreviousManualPatientEntryLogs,
} = require('../../controllers/v1/previousManualPatientController');
const {
    authenticate,
    authorizeRoles,
    enforceSelectedBranchScope,
} = require('../../middleware/authMiddleware');

const router = express.Router();

router.use(authenticate, authorizeRoles('doctor', 'receptionist'), enforceSelectedBranchScope);

router.get('/', listPreviousManualPatients);
router.post('/', createPreviousManualPatient);
router.put('/:previous_patient_id', updatePreviousManualPatient);
router.get('/:previous_patient_id/entry-logs', getPreviousManualPatientEntryLogs);

module.exports = router;
