const { query } = require('../config/db');
const { emitToUser } = require('./realtime');

const createNotificationsForRole = async ({
    roleCode,
    branchId = null,
    type,
    title,
    message,
    entityType,
    entityId,
    emitEvent = 'notification.new',
    emitPayload = null,
}) => {
    const users = await query(
        `SELECT u.id
         FROM master_users u
         JOIN master_roles r ON r.role_code = u.role
         ${branchId ? 'JOIN tbl_user_branch_access uba ON uba.user_id = u.id AND uba.branch_id = ? AND uba.is_active = 1' : ''}
         WHERE r.role_code = ?
           AND u.is_active = 1
           AND r.status = 1`,
        branchId ? [branchId, roleCode] : [roleCode]
    );

    if (users.length === 0) {
        return [];
    }

    await Promise.all(
        users.map((user) =>
            query(
                `INSERT INTO tbl_notifications
                 (user_id, branch_id, role_code, type, title, message, entity_type, entity_id)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                [user.id, branchId, roleCode, type, title, message, entityType, entityId]
            )
        )
    );

    await Promise.all(
        users.map((user) =>
            Promise.resolve(
                emitToUser(user.id, emitEvent, emitPayload || { type, title, message, entityType, entityId, branch_id: branchId })
            )
        )
    );

    return users;
};

const createNotificationForUser = async ({
    userId,
    branchId = null,
    roleCode,
    type,
    title,
    message,
    entityType,
    entityId,
    emitEvent = 'notification.new',
    emitPayload = null,
}) => {
    if (branchId) {
        const branchAccessRows = await query(
            `SELECT 1
             FROM tbl_user_branch_access uba
             JOIN master_clinic_branches b ON b.id = uba.branch_id
             WHERE uba.user_id = ?
               AND uba.branch_id = ?
               AND uba.is_active = 1
               AND b.is_active = 1
             LIMIT 1`,
            [userId, branchId]
        );

        if (branchAccessRows.length === 0) {
            return;
        }
    }

    await query(
        `INSERT INTO tbl_notifications
         (user_id, branch_id, role_code, type, title, message, entity_type, entity_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [userId, branchId, roleCode, type, title, message, entityType, entityId]
    );

    emitToUser(userId, emitEvent, emitPayload || { type, title, message, entityType, entityId, branch_id: branchId });
};

module.exports = {
    createNotificationsForRole,
    createNotificationForUser,
};
