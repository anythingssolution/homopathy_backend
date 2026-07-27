const express = require('express');
const {
    listFamilyMembers,
    createFamilyMember,
    updateFamilyMember,
} = require('../../controllers/v1/familyMemberController');
const { authenticate, authorizeRoles } = require('../../middleware/authMiddleware');

const router = express.Router();

router.get('/', authenticate, authorizeRoles('patient'), listFamilyMembers);
router.post('/', authenticate, authorizeRoles('patient'), createFamilyMember);
router.patch('/:family_member_id', authenticate, authorizeRoles('patient'), updateFamilyMember);

module.exports = router;
