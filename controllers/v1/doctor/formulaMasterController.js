const AppError = require('../../../utils/AppError');
const asyncHandler = require('../../../utils/asyncHandler');
const {
    getFormulaSetSummaries,
    getFormulaSetDetail,
    getDoctorFormulaSnapshot,
    upsertFormulaSet,
    activateFormulaSet,
    deleteFormulaSet,
    parseQuickFormulaInput,
} = require('../../../services/doctorFormulaCacheService');

const toPositiveInt = (value) => {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) {
        return null;
    }

    return parsed;
};

const listDoctorFormulaSets = asyncHandler(async (req, res) => {
    const sets = await getFormulaSetSummaries({ doctorId: req.user.id });
    const active = sets.find((item) => Number(item.is_active) === 1) || null;

    return res.status(200).json({
        success: true,
        message: 'Doctor formula sets fetched successfully',
        data: {
            sets,
            active_set_id: active ? Number(active.id) : null,
        },
        meta: {
            total: sets.length,
        },
    });
});

const getDoctorFormulaSet = asyncHandler(async (req, res) => {
    const setId = toPositiveInt(req.params.set_id);
    if (!setId) {
        throw new AppError('Valid formula set id is required', 400);
    }

    const detail = await getFormulaSetDetail({ doctorId: req.user.id, setId });
    if (!detail) {
        throw new AppError('Formula set not found', 404);
    }

    return res.status(200).json({
        success: true,
        message: 'Doctor formula set fetched successfully',
        data: detail,
    });
});

const getDoctorFormulaBootstrap = asyncHandler(async (req, res) => {
    const snapshot = await getDoctorFormulaSnapshot({ doctorId: req.user.id });

    return res.status(200).json({
        success: true,
        message: 'Doctor formula bootstrap fetched successfully',
        data: {
            snapshot,
        },
    });
});

const createDoctorFormulaSet = asyncHandler(async (req, res) => {
    const { detail, snapshot } = await upsertFormulaSet({
        doctorId: req.user.id,
        actorUserId: req.user.id,
        payload: req.body,
    });

    return res.status(201).json({
        success: true,
        message: 'Doctor formula set created successfully',
        data: {
            formula_set: detail,
            snapshot,
        },
    });
});

const updateDoctorFormulaSet = asyncHandler(async (req, res) => {
    const setId = toPositiveInt(req.params.set_id);
    if (!setId) {
        throw new AppError('Valid formula set id is required', 400);
    }

    const { detail, snapshot } = await upsertFormulaSet({
        doctorId: req.user.id,
        actorUserId: req.user.id,
        setId,
        payload: req.body,
    });

    return res.status(200).json({
        success: true,
        message: 'Doctor formula set updated successfully',
        data: {
            formula_set: detail,
            snapshot,
        },
    });
});

const activateDoctorFormulaSet = asyncHandler(async (req, res) => {
    const setId = toPositiveInt(req.params.set_id);
    if (!setId) {
        throw new AppError('Valid formula set id is required', 400);
    }

    const snapshot = await activateFormulaSet({
        doctorId: req.user.id,
        actorUserId: req.user.id,
        setId,
    });

    return res.status(200).json({
        success: true,
        message: 'Doctor formula set activated successfully',
        data: {
            snapshot,
        },
    });
});

const removeDoctorFormulaSet = asyncHandler(async (req, res) => {
    const setId = toPositiveInt(req.params.set_id);
    if (!setId) {
        throw new AppError('Valid formula set id is required', 400);
    }

    await deleteFormulaSet({
        doctorId: req.user.id,
        actorUserId: req.user.id,
        setId,
    });

    return res.status(200).json({
        success: true,
        message: 'Doctor formula set deleted successfully',
    });
});

const previewDoctorFormulaParse = asyncHandler(async (req, res) => {
    const rawInput = req.body?.input ? String(req.body.input) : '';
    const snapshot = await getDoctorFormulaSnapshot({ doctorId: req.user.id });
    const preview = parseQuickFormulaInput({
        rawInput,
        snapshot,
    });

    return res.status(200).json({
        success: true,
        message: 'Doctor formula preview generated successfully',
        data: preview,
    });
});

module.exports = {
    listDoctorFormulaSets,
    getDoctorFormulaSet,
    getDoctorFormulaBootstrap,
    createDoctorFormulaSet,
    updateDoctorFormulaSet,
    activateDoctorFormulaSet,
    removeDoctorFormulaSet,
    previewDoctorFormulaParse,
};
