const { query } = require('../../config/db');
const AppError = require('../../utils/AppError');
const asyncHandler = require('../../utils/asyncHandler');

const toPositiveInt = (value) => {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) {
        return null;
    }

    return parsed;
};

const listNotifications = asyncHandler(async (req, res) => {
    const unreadOnly = String(req.query.unread_only || '').trim() === 'true';
    const branchCondition = req.selectedBranchId ? 'AND branch_id = ?' : '';
    const params = req.selectedBranchId ? [req.user.id, req.selectedBranchId] : [req.user.id];

    const rows = await query(
        `SELECT id, branch_id, role_code, type, title, message, entity_type, entity_id, is_read, created_at, read_at
         FROM tbl_notifications
         WHERE user_id = ?
           ${branchCondition}
           ${unreadOnly ? 'AND is_read = 0' : ''}
         ORDER BY created_at DESC`,
        params
    );

    return res.status(200).json({
        success: true,
        message: 'Notifications fetched successfully',
        data: rows,
        meta: { unread_only: unreadOnly, total: rows.length },
    });
});

const markNotificationRead = asyncHandler(async (req, res) => {
    const notificationId = toPositiveInt(req.params.notification_id);
    if (!notificationId) {
        throw new AppError('Valid notification_id is required', 400);
    }

    await query(
        `UPDATE tbl_notifications
         SET is_read = 1,
             read_at = COALESCE(read_at, NOW())
         WHERE id = ?
           AND user_id = ?
           ${req.selectedBranchId ? 'AND branch_id = ?' : ''}`,
        req.selectedBranchId ? [notificationId, req.user.id, req.selectedBranchId] : [notificationId, req.user.id]
    );

    return res.status(200).json({
        success: true,
        message: 'Notification marked as read successfully',
    });
});

const markAllNotificationsRead = asyncHandler(async (req, res) => {
    await query(
        `UPDATE tbl_notifications
         SET is_read = 1,
             read_at = COALESCE(read_at, NOW())
         WHERE user_id = ?
           ${req.selectedBranchId ? 'AND branch_id = ?' : ''}
           AND is_read = 0`,
        req.selectedBranchId ? [req.user.id, req.selectedBranchId] : [req.user.id]
    );

    return res.status(200).json({
        success: true,
        message: 'All notifications marked as read successfully',
    });
});

module.exports = {
    listNotifications,
    markNotificationRead,
    markAllNotificationsRead,
};
