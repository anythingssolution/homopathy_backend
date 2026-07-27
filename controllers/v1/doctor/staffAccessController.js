const {
    query,
    withTransaction,
    AppError,
    asyncHandler,
    normalizeRoleCode,
    getCrossModuleAccessFlag,
    STAFF_ACCESS_ROLE_MAP,
    buildStaffAccessResponseRows,
} = require('./shared');

const listDoctorStaffAccess = asyncHandler(async (req, res) => {
    const branchId = req.selectedBranchId || null;
    const rows = await query(
        `SELECT role AS role_code,
                COUNT(DISTINCT u.id) AS total_users,
                MAX(COALESCE(has_cross_module_access, 0)) AS has_cross_module_access
         FROM master_users u
         JOIN tbl_user_branch_access uba
           ON uba.user_id = u.id
          AND uba.branch_id = ?
          AND uba.is_active = 1
         WHERE u.is_active = 1
           AND u.role IN ('REC', 'MED')
         GROUP BY u.role
         ORDER BY FIELD(u.role, 'REC', 'MED')`,
        [branchId]
    );

    return res.status(200).json({
        success: true,
        message: 'Staff access permissions fetched successfully',
        data: buildStaffAccessResponseRows(rows),
    });
});

const updateDoctorStaffAccess = asyncHandler(async (req, res) => {
    const permissions = Array.isArray(req.body?.permissions) ? req.body.permissions : null;

    if (!permissions || permissions.length === 0) {
        throw new AppError('permissions array is required', 400);
    }

    const normalizedPermissions = permissions.map((entry) => {
        const roleCode = normalizeRoleCode(entry?.role_code);
        if (!roleCode || !STAFF_ACCESS_ROLE_MAP[roleCode]) {
            throw new AppError('role_code must be REC or MED', 400);
        }

        return {
            role_code: roleCode,
            has_cross_module_access: getCrossModuleAccessFlag(entry?.has_cross_module_access),
        };
    });

    await withTransaction(async (connection) => {
        for (const permission of normalizedPermissions) {
            await connection.execute(
                `UPDATE master_users u
                 JOIN tbl_user_branch_access uba
                   ON uba.user_id = u.id
                  AND uba.branch_id = ?
                  AND uba.is_active = 1
                 SET u.has_cross_module_access = ?,
                     u.updated_at = NOW()
                 WHERE u.role = ?
                   AND u.is_active = 1`,
                [req.selectedBranchId, permission.has_cross_module_access, permission.role_code]
            );
        }
    });

    const rows = await query(
        `SELECT role AS role_code,
                COUNT(DISTINCT u.id) AS total_users,
                MAX(COALESCE(has_cross_module_access, 0)) AS has_cross_module_access
         FROM master_users u
         JOIN tbl_user_branch_access uba
           ON uba.user_id = u.id
          AND uba.branch_id = ?
          AND uba.is_active = 1
         WHERE u.is_active = 1
           AND u.role IN ('REC', 'MED')
         GROUP BY u.role
         ORDER BY FIELD(u.role, 'REC', 'MED')`,
        [req.selectedBranchId]
    );

    return res.status(200).json({
        success: true,
        message: 'Staff access permissions updated successfully',
        data: buildStaffAccessResponseRows(rows),
    });
});

module.exports = {
    listDoctorStaffAccess,
    updateDoctorStaffAccess,
};
