const express = require('express');
const {
    createRegisteredPatient,
    listRegisteredPatients,
    updateRegisteredPatient,
    getRegisteredPatientEntryLogs,
} = require('../../controllers/v1/patientRegistrationController');
const {
    authenticate,
    authorizeRoles,
} = require('../../middleware/authMiddleware');

const router = express.Router();

router.use(authenticate, authorizeRoles('doctor', 'receptionist'));

router.get('/', listRegisteredPatients);
router.post('/', createRegisteredPatient);
router.put('/:patient_id', updateRegisteredPatient);
router.get('/:patient_id/entry-logs', getRegisteredPatientEntryLogs);

module.exports = router;
