const asyncHandler = require('../../utils/asyncHandler');
const { query } = require('../../config/db');
const { env } = require('../../config/env');
const { verifyMetaWebhookSignature } = require('../../utils/whatsappService');

const verifyWebhook = asyncHandler(async (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token === env.whatsapp.webhookVerifyToken) {
        console.log('[WhatsApp Webhook] Verification successful');
        return res.status(200).send(challenge);
    }

    console.warn('[WhatsApp Webhook] Verification failed: Token mismatch or invalid mode');
    return res.status(403).json({ error: 'Verification failed' });
});

const handleWebhookEvent = asyncHandler(async (req, res) => {
    // Return HTTP 200 immediately as per Meta Cloud API requirements
    res.status(200).json({ status: 'received' });

    const rawBody = req.rawBody || JSON.stringify(req.body);
    const signature = req.headers['x-hub-signature-256'];

    if (env.whatsapp.appSecret && !verifyMetaWebhookSignature(rawBody, signature)) {
        console.warn('[WhatsApp Webhook] Invalid HMAC signature received');
        return;
    }

    const body = req.body;
    if (!body || body.object !== 'whatsapp_business_account') {
        return;
    }

    const entries = Array.isArray(body.entry) ? body.entry : [];
    for (const entry of entries) {
        const changes = Array.isArray(entry.changes) ? entry.changes : [];
        for (const change of changes) {
            const value = change?.value;
            if (!value) continue;

            const statuses = Array.isArray(value.statuses) ? value.statuses : [];
            for (const statusObj of statuses) {
                const providerMessageId = statusObj.id;
                const statusName = statusObj.status; // 'sent', 'delivered', 'read', 'failed'
                const timestamp = statusObj.timestamp ? new Date(Number(statusObj.timestamp) * 1000) : new Date();

                if (!providerMessageId || !statusName) continue;

                // Check idempotency: log event in tbl_whatsapp_webhook_events
                try {
                    await query(
                        `INSERT INTO tbl_whatsapp_webhook_events
                         (provider_message_id, event_type, raw_payload_json, is_processed)
                         VALUES (?, ?, ?, 1)`,
                        [providerMessageId, statusName, JSON.stringify(statusObj)]
                    );
                } catch (dbErr) {
                    // Duplicate event (already processed)
                    if (dbErr.code === 'ER_DUP_ENTRY') {
                        continue;
                    }
                    console.error('[WhatsApp Webhook] Error saving webhook event:', dbErr);
                }

                // Update tbl_whatsapp_messages status
                let updateField = '';
                if (statusName === 'delivered') updateField = ', delivered_at = COALESCE(delivered_at, NOW())';
                if (statusName === 'read') updateField = ', read_at = COALESCE(read_at, NOW())';
                if (statusName === 'failed') updateField = ', failed_at = COALESCE(failed_at, NOW())';

                let errorCode = null;
                let errorMessage = null;
                if (statusName === 'failed' && statusObj.errors?.[0]) {
                    errorCode = String(statusObj.errors[0].code || 'WEBHOOK_FAILED');
                    errorMessage = String(statusObj.errors[0].title || statusObj.errors[0].message || 'Delivery failed');
                }

                await query(
                    `UPDATE tbl_whatsapp_messages
                     SET status = ?,
                         error_code = COALESCE(?, error_code),
                         error_message = COALESCE(?, error_message)
                         ${updateField}
                     WHERE provider_message_id = ?`,
                    [statusName, errorCode, errorMessage, providerMessageId]
                );

                if (statusName === 'delivered' || statusName === 'read') {
                    await query(
                        `UPDATE master_users u
                         JOIN tbl_whatsapp_messages m ON m.fk_patient_id = u.id
                         SET u.last_whatsapp_delivery_at = NOW()
                         WHERE m.provider_message_id = ?`,
                        [providerMessageId]
                    );
                }
            }
        }
    }
});

module.exports = {
    verifyWebhook,
    handleWebhookEvent,
};
