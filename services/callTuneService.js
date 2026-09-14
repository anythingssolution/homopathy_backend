const { query } = require('../config/db');
const AppError = require('../utils/AppError');

const CALL_TUNE_MODES = ['CHIME', 'TEMPLATE', 'CUSTOM'];
const CUSTOM_TEXT_MAX = 200;
const DEFAULT_SETTING = {
    mode: 'CHIME',
    custom_text: null,
};

const toPositiveInt = (value) => {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

const formatSetting = (row, branchId) => ({
    branch_id: Number(row?.fk_branch_id || branchId),
    mode: CALL_TUNE_MODES.includes(row?.mode) ? row.mode : 'CHIME',
    custom_text: row?.custom_text ? String(row.custom_text) : null,
});

const getCallTuneSetting = async (branchId) => {
    const normalizedBranchId = toPositiveInt(branchId);
    if (!normalizedBranchId) {
        throw new AppError('branch_id is required', 400);
    }

    try {
        const rows = await query(
            `SELECT fk_branch_id, mode, custom_text
             FROM tbl_branch_call_tune_settings
             WHERE fk_branch_id = ?
             LIMIT 1`,
            [normalizedBranchId]
        );

        if (!rows[0]) {
            return { ...DEFAULT_SETTING, branch_id: normalizedBranchId };
        }

        return formatSetting(rows[0], normalizedBranchId);
    } catch (error) {
        // Code can deploy before the migration: TV must keep the existing chime.
        if (error?.code === 'ER_NO_SUCH_TABLE') {
            return { ...DEFAULT_SETTING, branch_id: normalizedBranchId };
        }
        throw error;
    }
};

const saveCallTuneSetting = async ({ branchId, mode, customText, actorUserId }) => {
    const normalizedBranchId = toPositiveInt(branchId);
    if (!normalizedBranchId) {
        throw new AppError('branch_id is required', 400);
    }

    const normalizedMode = String(mode || 'CHIME').trim().toUpperCase();
    if (!CALL_TUNE_MODES.includes(normalizedMode)) {
        throw new AppError('mode must be CHIME, TEMPLATE, or CUSTOM', 400);
    }

    const normalizedCustom = String(customText || '').trim().slice(0, CUSTOM_TEXT_MAX) || null;
    if (normalizedMode === 'CUSTOM' && !normalizedCustom) {
        throw new AppError('Please enter the custom announcement text', 400);
    }

    const storedText = normalizedCustom;

    await query(
        `INSERT INTO tbl_branch_call_tune_settings (fk_branch_id, mode, custom_text, updated_by)
         VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           mode = VALUES(mode),
           custom_text = VALUES(custom_text),
           updated_by = VALUES(updated_by)`,
        [normalizedBranchId, normalizedMode, storedText, actorUserId || null]
    );

    return getCallTuneSetting(normalizedBranchId);
};

module.exports = {
    CALL_TUNE_MODES,
    CUSTOM_TEXT_MAX,
    getCallTuneSetting,
    saveCallTuneSetting,
};
