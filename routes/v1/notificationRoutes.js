const express = require('express');
const {
    listNotifications,
    markNotificationRead,
    markAllNotificationsRead,
} = require('../../controllers/v1/notificationController');
const { authenticate, authorizeRoles, enforceSelectedBranchScope } = require('../../middleware/authMiddleware');

const router = express.Router();

router.use(authenticate, authorizeRoles('patient', 'doctor', 'receptionist', 'medical'), enforceSelectedBranchScope);

router.get('/', listNotifications);
router.patch('/:notification_id/read', markNotificationRead);
router.patch('/read-all', markAllNotificationsRead);

module.exports = router;
