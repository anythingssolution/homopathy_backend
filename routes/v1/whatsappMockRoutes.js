const express = require('express');
const router = express.Router();
const { authenticate } = require('../../middleware/authMiddleware');
const {
    getMockConversations,
    getMockMessages,
    sendMockMessage,
    updateMockMessageStatus,
    runMockScheduler,
    getMockScheduledQueue,
    getMockEventLogs,
} = require('../../controllers/v1/whatsappMockController');

router.use(authenticate);

router.get('/conversations', getMockConversations);
router.get('/conversations/:patient_id/messages', getMockMessages);
router.post('/conversations/:patient_id/send', sendMockMessage);
router.post('/messages/:id/status', updateMockMessageStatus);
router.post('/run-scheduler', runMockScheduler);
router.get('/scheduled-queue', getMockScheduledQueue);
router.get('/event-logs', getMockEventLogs);

module.exports = router;
