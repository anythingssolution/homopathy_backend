const ROLE_CODE_TO_ROLE = {
    PAT: 'patient',
    DOC: 'doctor',
    REC: 'receptionist',
    MED: 'medical',
    MEDS: 'medical',
};

const ROLE_NAME_TO_CODE = {
    patient: 'PAT',
    doctor: 'DOC',
    receptionist: 'REC',
    medical: 'MED',
};

const ROLE_ALIASES = {
    pat: 'PAT',
    patient: 'PAT',
    doc: 'DOC',
    doctor: 'DOC',
    rec: 'REC',
    receptionist: 'REC',
    med: 'MED',
    medical: 'MED',
    meds: 'MEDS',
    medical_staff: 'MEDS',
    'medical-staff': 'MEDS',
};

const normalizeRoleCode = (value) => {
    const raw = String(value || '').trim();
    if (!raw) {
        return null;
    }

    const upper = raw.toUpperCase();
    if (ROLE_CODE_TO_ROLE[upper]) {
        return upper;
    }

    return ROLE_ALIASES[raw.toLowerCase()] || null;
};

const normalizeRole = (value) => {
    const code = normalizeRoleCode(value);
    return code ? ROLE_CODE_TO_ROLE[code] : null;
};

const getRoleMeta = (value) => {
    const role_code = normalizeRoleCode(value);
    const role = role_code ? ROLE_CODE_TO_ROLE[role_code] : null;

    return {
        role,
        role_code,
    };
};

const isSupportedRole = (value) => Boolean(normalizeRoleCode(value));

module.exports = {
    normalizeRole,
    normalizeRoleCode,
    getRoleMeta,
    isSupportedRole,
    ROLE_CODE_TO_ROLE,
    ROLE_NAME_TO_CODE,
};
