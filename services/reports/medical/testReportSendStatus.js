const { query } = require('../../../config/db');
const AppError = require('../../../utils/AppError');

const SOURCE_TYPES = new Set(['CONSULTATION', 'BILL']);
const STATUSES = new Set(['SENT', 'NOT_SENT']);
const NOT_SENT_REASON_MAX = 500;

const normalizeSourceType = (value) => String(value || '').trim().toUpperCase();

const normalizeStatusPayload = ({ sourceType, sourceId, status, reason }) => {
    const normalizedSourceType = normalizeSourceType(sourceType);
    const normalizedStatus = String(status || '').trim().toUpperCase();
    const normalizedSourceId = Number(sourceId);
    const normalizedReason = reason == null ? '' : String(reason).trim();

    if (!SOURCE_TYPES.has(normalizedSourceType)) {
        throw new AppError('source_type must be CONSULTATION or BILL', 400);
    }

    if (!Number.isInteger(normalizedSourceId) || normalizedSourceId <= 0) {
        throw new AppError('source_id must be a positive integer', 400);
    }

    if (!STATUSES.has(normalizedStatus)) {
        throw new AppError('status must be SENT or NOT_SENT', 400);
    }

    if (normalizedReason.length > NOT_SENT_REASON_MAX) {
        throw new AppError(`reason must be at most ${NOT_SENT_REASON_MAX} characters`, 400);
    }

    if (normalizedStatus === 'NOT_SENT' && !normalizedReason) {
        throw new AppError('reason is required when report is not sent', 400);
    }

    return {
        sourceType: normalizedSourceType,
        sourceId: normalizedSourceId,
        status: normalizedStatus,
        reason: normalizedStatus === 'NOT_SENT' ? normalizedReason : null,
    };
};

const resolveReportSource = async ({ sourceType, sourceId }) => {
    if (sourceType === 'CONSULTATION') {
        const rows = await query(
            `SELECT
                ct.id AS source_id,
                ct.consultation_id,
                a.fk_branch_id
             FROM tbl_consultation_tests ct
             JOIN tbl_consultations c ON c.id = ct.consultation_id
             JOIN tbl_appointments a ON a.appointment_id = c.appointment_id
             WHERE ct.id = ?
             LIMIT 1`,
            [sourceId]
        );
        return rows[0] || null;
    }

    const rows = await query(
        `SELECT
            bi.id AS source_id,
            b.id AS bill_id,
            b.fk_branch_id
         FROM tbl_bill_items bi
         JOIN tbl_bills b ON b.id = bi.bill_id
         WHERE bi.id = ?
           AND b.status = 'ACTIVE'
           AND b.bill_type = 'MEDICATION'
           AND b.appointment_id IS NULL
           AND bi.item_type = 'TEST'
           AND bi.consultation_test_id IS NULL
         LIMIT 1`,
        [sourceId]
    );
    return rows[0] || null;
};

const saveTestReportSendStatus = async ({ sourceType, sourceId, status, reason, actorUserId, selectedBranchId }) => {
    const payload = normalizeStatusPayload({ sourceType, sourceId, status, reason });
    const source = await resolveReportSource(payload);

    if (!source) {
        throw new AppError('Test report source not found', 404);
    }

    if (selectedBranchId && Number(source.fk_branch_id) !== Number(selectedBranchId)) {
        throw new AppError('You can access only the currently selected branch data', 403, {
            selected_branch_id: selectedBranchId,
        });
    }

    await query(
        `INSERT INTO tbl_test_report_send_status
            (source_type, source_id, status, not_sent_reason, marked_by, marked_at)
         VALUES (?, ?, ?, ?, ?, NOW())
         ON DUPLICATE KEY UPDATE
            status = VALUES(status),
            not_sent_reason = VALUES(not_sent_reason),
            marked_by = VALUES(marked_by),
            marked_at = NOW()`,
        [payload.sourceType, payload.sourceId, payload.status, payload.reason, actorUserId || null]
    );

    const rows = await query(
        `SELECT
            trs.source_type,
            trs.source_id,
            trs.status AS report_send_status,
            trs.not_sent_reason AS report_not_sent_reason,
            trs.marked_at AS report_status_marked_at,
            u.full_name AS report_status_marked_by_name
         FROM tbl_test_report_send_status trs
         LEFT JOIN master_users u ON u.id = trs.marked_by
         WHERE trs.source_type = ?
           AND trs.source_id = ?
         LIMIT 1`,
        [payload.sourceType, payload.sourceId]
    );

    return rows[0] || null;
};

module.exports = {
    normalizeStatusPayload,
    saveTestReportSendStatus,
};
