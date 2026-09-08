const express = require('express');
const {
    createStaffPatient,
    listStaffPatients,
} = require('../../controllers/v1/staffPatientController');
const {
    authenticate,
    authorizeRoles,
    enforceSelectedBranchScope,
} = require('../../middleware/authMiddleware');

const router = express.Router();

router.use(authenticate, authorizeRoles('doctor', 'receptionist', 'medical', 'MEDS'), enforceSelectedBranchScope);

router.get('/', listStaffPatients);
router.post('/', createStaffPatient);

module.exports = router;
