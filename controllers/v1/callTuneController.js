const AppError = require('../../utils/AppError');
const asyncHandler = require('../../utils/asyncHandler');
const { getCallTuneSetting, saveCallTuneSetting } = require('../../services/callTuneService');

const toPositiveInt = (value) => {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

const resolveBranchId = (req) => {
    const branchId = toPositiveInt(req.selectedBranchId || req.query.branch_id || req.body?.branch_id);
    if (!branchId) {
        throw new AppError('branch_id is required', 400);
    }
    return branchId;
};

const getDoctorCallTune = asyncHandler(async (req, res) => {
    const setting = await getCallTuneSetting(resolveBranchId(req));
    return res.status(200).json({
        success: true,
        message: 'Call tune setting fetched successfully',
        data: setting,
    });
});

const saveDoctorCallTune = asyncHandler(async (req, res) => {
    const setting = await saveCallTuneSetting({
        branchId: resolveBranchId(req),
        mode: req.body?.mode,
        customText: req.body?.custom_text ?? req.body?.customText,
        actorUserId: req.user?.id,
    });
    return res.status(200).json({
        success: true,
        message: 'Call tune setting saved successfully',
        data: setting,
    });
});

const getPublicCallTune = asyncHandler(async (req, res) => {
    const branchId = toPositiveInt(req.query.branch_id);
    if (!branchId) {
        throw new AppError('branch_id is required', 400);
    }
    const setting = await getCallTuneSetting(branchId);
    return res.status(200).json({
        success: true,
        message: 'Call tune setting fetched successfully',
        data: setting,
    });
});

module.exports = {
    getDoctorCallTune,
    saveDoctorCallTune,
    getPublicCallTune,
};
