const { normalizeRoleCode } = require('./roles');

const BRANCH_SCOPED_ROLE_CODES = new Set(['DOC', 'REC', 'MED']);

const isBranchScopedRole = (value) => {
    const roleCode = typeof value === 'object'
        ? normalizeRoleCode(value?.role_code || value?.role)
        : normalizeRoleCode(value);

    return BRANCH_SCOPED_ROLE_CODES.has(roleCode);
};

module.exports = {
    BRANCH_SCOPED_ROLE_CODES,
    isBranchScopedRole,
};
