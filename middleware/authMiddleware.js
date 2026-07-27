const jwt = require('jsonwebtoken');
const { query } = require('../config/db');
const { env } = require('../config/env');
const AppError = require('../utils/AppError');
const { normalizeRole, normalizeRoleCode, isSupportedRole } = require('../utils/roles');
const { getModuleAccessFromUser, hasModuleAccess } = require('../utils/moduleAccess');
const { isBranchScopedRole } = require('../utils/branchScope');

const authenticate = async (req, res, next) => {
    try {
        const authHeader = req.headers.authorization || '';

        if (!authHeader.startsWith('Bearer ')) {
            return next(new AppError('Authorization token is missing', 401));
        }

        const token = authHeader.split(' ')[1];
        const decoded = jwt.verify(token, env.jwtSecret);

        if (decoded.type && decoded.type !== 'access') {
            return next(new AppError('Invalid token type for protected resource', 401));
        }

        if (decoded.jti) {
            const blacklistedTokens = await query(
                `SELECT id
                 FROM tbl_user_access_token_blacklist
                 WHERE token_jti = ?
                   AND revoked_at IS NOT NULL
                 LIMIT 1`,
                [decoded.jti]
            );

            if (blacklistedTokens.length > 0) {
                return next(new AppError('Token has been revoked. Please login again.', 401));
            }
        }

        const users = await query(
            `SELECT u.id,
                    u.uuid,
                    u.mobile_no,
                    u.role AS role_code,
                    COALESCE(u.has_cross_module_access, 0) AS has_cross_module_access,
                    u.selected_branch_id,
                    CASE
                        WHEN u.selected_branch_id IS NULL THEN 0
                        WHEN EXISTS (
                            SELECT 1
                            FROM tbl_user_branch_access uba
                            JOIN master_clinic_branches b ON b.id = uba.branch_id
                            WHERE uba.user_id = u.id
                              AND uba.branch_id = u.selected_branch_id
                              AND uba.is_active = 1
                              AND b.is_active = 1
                        ) THEN 1
                        ELSE 0
                    END AS has_selected_branch_access,
                    u.is_active,
                    r.role_name,
                    r.role_code AS verified_role_code,
                    r.status AS role_status
             FROM master_users u
             LEFT JOIN master_roles r
               ON r.role_code = u.role
             WHERE u.id = ?
             LIMIT 1`,
            [decoded.id]
        );

        if (users.length === 0) {
            return next(new AppError('Authenticated user not found', 401));
        }

        const user = users[0];

        if (!user.is_active) {
            return next(new AppError('User account is inactive', 403));
        }

        const roleCodeFromDb = normalizeRoleCode(user.verified_role_code || user.role_code);

        if (!roleCodeFromDb || user.role_status !== 1) {
            return next(new AppError('User role is invalid or inactive. Please contact support.', 403));
        }

        if (!isSupportedRole(roleCodeFromDb)) {
            return next(new AppError('User role is not supported by API authorization rules', 403));
        }

        req.user = {
            id: user.id,
            uuid: user.uuid,
            mobile_no: user.mobile_no,
            role: normalizeRole(roleCodeFromDb),
            role_code: roleCodeFromDb,
            ...getModuleAccessFromUser(user),
            selected_branch_id: user.selected_branch_id && Number(user.has_selected_branch_access) === 1
                ? Number(user.selected_branch_id)
                : null,
            token_jti: decoded.jti || null,
            token,
        };

        return next();
    } catch (error) {
        return next(new AppError('Invalid or expired token', 401));
    }
};

const authorizeRoles = (...allowedRoles) => {
    const normalizedAllowedRoleCodes = allowedRoles
        .map((role) => normalizeRoleCode(role))
        .filter(Boolean);

    return (req, res, next) => {
        const userRoleCode = normalizeRoleCode(req.user?.role_code || req.user?.role);

        if (!userRoleCode) {
            return next(new AppError('User role is missing in authenticated request', 403));
        }

        if (!normalizedAllowedRoleCodes.includes(userRoleCode)) {
            return next(new AppError('You are not authorized to access this resource', 403));
        }

        return next();
    };
};

const authorizeModuleAccess = (module) => (req, res, next) => {
    if (!req.user) {
        return next(new AppError('Authenticated user is missing in request context', 401));
    }

    if (!hasModuleAccess(req.user, module)) {
        return next(new AppError('You are not authorized to access this module', 403));
    }

    return next();
};

const authorizeRolesOrModuleAccess = (allowedRoles, module) => {
    const normalizedAllowedRoleCodes = (Array.isArray(allowedRoles) ? allowedRoles : [allowedRoles])
        .map((role) => normalizeRoleCode(role))
        .filter(Boolean);

    return (req, res, next) => {
        const userRoleCode = normalizeRoleCode(req.user?.role_code || req.user?.role);

        if (userRoleCode && normalizedAllowedRoleCodes.includes(userRoleCode)) {
            return next();
        }

        if (hasModuleAccess(req.user, module)) {
            return next();
        }

        return next(new AppError('You are not authorized to access this resource', 403));
    };
};

const enforceSelectedBranchScope = (req, _res, next) => {
    if (!req.user || !isBranchScopedRole(req.user)) {
        return next();
    }

    const selectedBranchId = Number(req.user.selected_branch_id) || null;

    if (!selectedBranchId) {
        return next(new AppError('Please select a branch before using this module', 409, {
            branch_selection_required: true,
        }));
    }

    const requestedQueryBranchId = req.query?.branch_id !== undefined && req.query?.branch_id !== null
        ? Number(req.query.branch_id)
        : null;
    const requestedBodyBranchId = req.body?.branch_id !== undefined && req.body?.branch_id !== null
        ? Number(req.body.branch_id)
        : null;
    const requestedBodyFkBranchId = req.body?.fk_branch_id !== undefined && req.body?.fk_branch_id !== null
        ? Number(req.body.fk_branch_id)
        : null;

    for (const requestedBranchId of [requestedQueryBranchId, requestedBodyBranchId, requestedBodyFkBranchId]) {
        if (requestedBranchId && requestedBranchId !== selectedBranchId) {
            return next(new AppError('You can access only the currently selected branch data', 403, {
                selected_branch_id: selectedBranchId,
            }));
        }
    }

    req.selectedBranchId = selectedBranchId;
    req.branchScope = {
        branch_id: selectedBranchId,
    };

    if (req.query && req.query.branch_id === undefined) {
        req.query.branch_id = String(selectedBranchId);
    }

    if (req.body && typeof req.body === 'object') {
        if (req.body.branch_id === undefined) {
            req.body.branch_id = selectedBranchId;
        }

        if (req.body.fk_branch_id === undefined) {
            req.body.fk_branch_id = selectedBranchId;
        }
    }

    return next();
};

const buildEntityBranchScopeGuard = ({ resolveBranchId, entityLabel, paramName }) => async (req, _res, next) => {
    try {
        if (!req.user || !isBranchScopedRole(req.user)) {
            return next();
        }

        const selectedBranchId = Number(req.user.selected_branch_id) || null;
        if (!selectedBranchId) {
            return next(new AppError('Please select a branch before using this module', 409, {
                branch_selection_required: true,
            }));
        }

        const entityId = Number(req.params?.[paramName]);
        if (!Number.isInteger(entityId) || entityId <= 0) {
            return next(new AppError(`Valid ${paramName} is required`, 400));
        }

        const entityBranchId = await resolveBranchId(entityId);

        if (!entityBranchId) {
            return next(new AppError(`${entityLabel} not found`, 404));
        }

        if (Number(entityBranchId) !== selectedBranchId) {
            return next(new AppError(`You can access only the currently selected branch ${entityLabel}`, 403, {
                selected_branch_id: selectedBranchId,
            }));
        }

        return next();
    } catch (error) {
        return next(error);
    }
};

const authorizeAppointmentBranchScope = buildEntityBranchScopeGuard({
    entityLabel: 'appointment',
    paramName: 'appointment_id',
    resolveBranchId: async (appointmentId) => {
        const rows = await query(
            `SELECT fk_branch_id
             FROM tbl_appointments
             WHERE appointment_id = ?
             LIMIT 1`,
            [appointmentId]
        );

        return rows[0]?.fk_branch_id ? Number(rows[0].fk_branch_id) : null;
    },
});

const authorizeConsultationBranchScope = buildEntityBranchScopeGuard({
    entityLabel: 'consultation',
    paramName: 'consultation_id',
    resolveBranchId: async (consultationId) => {
        const rows = await query(
            `SELECT a.fk_branch_id
             FROM tbl_consultations c
             JOIN tbl_appointments a ON a.appointment_id = c.appointment_id
             WHERE c.id = ?
             LIMIT 1`,
            [consultationId]
        );

        return rows[0]?.fk_branch_id ? Number(rows[0].fk_branch_id) : null;
    },
});

const authorizeBillBranchScope = buildEntityBranchScopeGuard({
    entityLabel: 'bill',
    paramName: 'bill_id',
    resolveBranchId: async (billId) => {
        const rows = await query(
            `SELECT fk_branch_id
             FROM tbl_bills
             WHERE id = ?
             LIMIT 1`,
            [billId]
        );

        return rows[0]?.fk_branch_id ? Number(rows[0].fk_branch_id) : null;
    },
});

module.exports = {
    authenticate,
    authorizeRoles,
    authorizeModuleAccess,
    authorizeRolesOrModuleAccess,
    enforceSelectedBranchScope,
    authorizeAppointmentBranchScope,
    authorizeConsultationBranchScope,
    authorizeBillBranchScope,
};
