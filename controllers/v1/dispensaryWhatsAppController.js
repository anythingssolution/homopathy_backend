const asyncHandler = require('../../utils/asyncHandler');
const AppError = require('../../utils/AppError');
const { query, pool } = require('../../config/db');
const crypto = require('crypto');
const { getBillDetailById } = require('../../services/billingService');
const { renderDispensaryDocument } = require('../../services/dispensarySharing/document');
const { buildDocumentModel, normalizePhone, positiveId } = require('../../services/dispensarySharing/model');
const ProviderFactory = require('../../services/whatsapp/WhatsAppProviderFactory');
const { env } = require('../../config/env');

// Concurrent retries share the same send operation. Completed keys expire after ten minutes.
const sends = new Map();
const context = async req => {
    const id = positiveId(req.params.bill_id);
    if (!id) throw new AppError('Valid bill ID required', 400);
    const bill = await getBillDetailById(id);
    if (!bill) throw new AppError('Bill not found', 404);
    if (String(bill.bill_type).toUpperCase() !== 'MEDICATION') throw new AppError('Select a dispensary bill', 400);
    if (Number(bill.branch_id) !== Number(req.user.selected_branch_id)) throw new AppError('Select this bill branch before sharing', 403);
    const rows = await query(`SELECT p.id, p.full_name, p.uuid, p.mobile_no, p.whatsapp_number, p.whatsapp_consent_status,
        fm.full_name AS family_name, NULL AS family_mobile_no, fm.id AS family_id,
        COALESCE(fm.full_name, p.full_name) AS display_name
        FROM master_users p
        LEFT JOIN tbl_consultations c ON c.id = ?
        LEFT JOIN tbl_appointments a ON a.appointment_id = COALESCE(?, c.appointment_id)
        LEFT JOIN tbl_patient_family_members fm ON fm.id = a.fk_patient_family_member_id AND fm.fk_primary_patient_id = p.id
        WHERE p.id = ? AND p.is_active = 1`, [bill.consultation_id, bill.appointment_id, bill.patient_id]);
    if (!rows[0]) throw new AppError('Patient not found or inactive', 404);
    return { bill, patient: rows[0] };
};
const preview = asyncHandler(async (req, res) => {
    const { bill, patient } = await context(req);
    const model = buildDocumentModel(bill, patient, req.body);
    const pdf = await renderDispensaryDocument(model);
    const status = await query(`SELECT id, status, error_code, created_at, recipient_phone, provider_message_id FROM tbl_whatsapp_messages
        WHERE fk_bill_id = ? AND message_type = 'DOCUMENT' ORDER BY id DESC LIMIT 1`, [bill.bill_id]);
    const configured = String(process.env.WHATSAPP_PROVIDER || 'mock').toLowerCase();
    const mode = configured === 'meta' && (!env.whatsapp.accessToken || !env.whatsapp.phoneNumberId) ? 'UNAVAILABLE' : ProviderFactory.isMockMode() ? 'MOCK' : 'LIVE';
    res.json({ success: true, data: {
        document: model, filename: model.filename, fingerprint: model.fingerprint, pdf_base64: pdf.toString('base64'), mode,
        patient_name: model.patient_name, patient_uuid: patient.uuid,
        family_name: patient.family_name || null, consent: patient.whatsapp_consent_status, last_message: status[0] ? { ...status[0], simulated: String(status[0].provider_message_id || '').startsWith('mock_msg_') } : null,
        recipients: [
            { name: patient.full_name, phone: patient.whatsapp_number || patient.mobile_no, type: 'PATIENT' },
        ],
    } });
});
const send = asyncHandler(async (req, res) => {
    const { bill, patient } = await context(req);
    if (patient.whatsapp_consent_status === 'OPTED_OUT') throw new AppError('Patient has opted out of WhatsApp messages', 400);
    const phone = normalizePhone(req.body.recipient_phone);
    const model = buildDocumentModel(bill, patient, req.body);
    if (req.body.fingerprint !== model.fingerprint) throw new AppError('Bill or receipt changed. Reopen the preview before sending.', 409);
    const requestId = String(req.body.request_id || '');
    if (!/^[\w-]{16,80}$/.test(requestId)) throw new AppError('Valid send request required', 400);
    if (String(process.env.WHATSAPP_PROVIDER || 'mock').toLowerCase() === 'meta' && (!env.whatsapp.accessToken || !env.whatsapp.phoneNumberId)) throw new AppError('WhatsApp delivery is not configured. Contact the clinic administrator.', 503);
    const key = `${req.user.id}:${bill.bill_id}:${phone}:${model.fingerprint}:${requestId}`;
    const now = Date.now();
    for (const [savedKey, entry] of sends) if (entry.expires < now) sends.delete(savedKey);
    if (!sends.has(key)) {
        const promise = (async () => {
            const reference = `dispensary-share:${crypto.createHash('sha256').update(key).digest('hex')}`;
            const lockName = reference.slice(0, 64);
            const connection = await pool.getConnection();
            try {
                const [locks] = await connection.query('SELECT GET_LOCK(?, 30) AS acquired', [lockName]);
                if (Number(locks[0]?.acquired) !== 1) throw new AppError('A send is already in progress. Please retry shortly.', 409);
                const [saved] = await connection.query(`SELECT id, status, provider_message_id FROM tbl_whatsapp_messages
                    WHERE fk_bill_id = ? AND media_url = ? ORDER BY id DESC LIMIT 1`, [bill.bill_id, reference]);
                if (saved[0]) return { status: saved[0].status, messageId: saved[0].id, simulated: String(saved[0].provider_message_id || '').startsWith('mock_msg_') };
                const provider = ProviderFactory.getProvider();
                const pdf = await renderDispensaryDocument(model);
                const result = await provider.sendDocumentMessage({
                mobileNo: phone, documentBuffer: pdf, documentUrl: reference, filename: model.filename,
                caption: `${model.kind === 'RECEIPT' ? 'Payment receipt' : 'Bill'} ${bill.bill_number} - ${model.patient_name}`,
                patientId: patient.id, branchId: bill.branch_id, appointmentId: bill.appointment_id,
                prescriptionId: null, billId: bill.bill_id, createdBy: req.user.id,
            });
                return { ...result, simulated: provider.getProviderName() === 'MOCK' };
            } finally {
                try { await connection.query('SELECT RELEASE_LOCK(?)', [lockName]); } finally { connection.release(); }
            }
        })();
        sends.set(key, { promise, expires: now + 600000 });
        promise.catch(() => sends.delete(key));
    }
    const result = await sends.get(key).promise;
    res.status(result.status === 'failed' ? 502 : 200).json({
        success: ['sent', 'delivered', 'read'].includes(result.status),
        message: result.simulated ? 'Simulation complete. No message was sent to the patient.' : result.status === 'failed' ? 'WhatsApp delivery failed. Please retry.' : 'Document submitted to WhatsApp. Delivery status will update separately.',
        data: { status: result.status, message_id: result.messageId, simulated: result.simulated },
    });
});
const status = asyncHandler(async (req, res) => {
    const { bill } = await context(req);
    const rows = await query(`SELECT id, status, error_code, created_at, recipient_phone, provider_message_id
        FROM tbl_whatsapp_messages WHERE fk_bill_id = ? AND id = ? LIMIT 1`, [bill.bill_id, positiveId(req.params.message_id)]);
    if (!rows[0]) throw new AppError('Message not found', 404);
    const row = rows[0];
    res.json({ success: true, data: { ...row, simulated: String(row.provider_message_id || '').startsWith('mock_msg_') } });
});
module.exports = { preview, send, status };
