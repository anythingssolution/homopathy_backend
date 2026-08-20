const express = require('express');
const router = express.Router();
const {
    verifyWebhook,
    handleWebhookEvent,
} = require('../../controllers/v1/whatsappWebhookController');

router.get('/whatsapp', verifyWebhook);
router.post('/whatsapp', handleWebhookEvent);

module.exports = router;
