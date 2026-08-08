const { normalizeRoleCode } = require('./roles');

const getCrossModuleAccessFlag = (value) => (Number(value) === 1 ? 1 : 0);

const getModuleAccessFromUser = (user) => {
    const roleCode = normalizeRoleCode(user?.role_code || user?.role);
    const hasCrossModuleAccess = getCrossModuleAccessFlag(user?.has_cross_module_access);

    const canAccessReceptionModule = roleCode === 'REC' || (roleCode === 'MED' && hasCrossModuleAccess === 1) ? 1 : 0;
    const canAccessMedicalModule = roleCode === 'DOC' || roleCode === 'MED' || (roleCode === 'REC' && hasCrossModuleAccess === 1) ? 1 : 0;

    return {
        has_cross_module_access: hasCrossModuleAccess,
        can_access_reception_module: canAccessReceptionModule,
        can_access_medical_module: canAccessMedicalModule,
    };
};

const hasModuleAccess = (user, module) => {
    const normalizedModule = String(module || '').trim().toUpperCase();
    const access = getModuleAccessFromUser(user);

    if (normalizedModule === 'RECEPTION') {
        return access.can_access_reception_module === 1;
    }

    if (normalizedModule === 'MEDICAL') {
        return access.can_access_medical_module === 1;
    }

    return false;
};

module.exports = {
    getCrossModuleAccessFlag,
    getModuleAccessFromUser,
    hasModuleAccess,
};
