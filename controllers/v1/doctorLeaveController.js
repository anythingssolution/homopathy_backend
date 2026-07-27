const AppError = require('../../utils/AppError');
const asyncHandler = require('../../utils/asyncHandler');
const {
    getCurrentMonthString,
    createDoctorLeave,
    createDoctorLeavesBulk,
    cancelDoctorLeave,
    cancelDoctorLeavesBulk,
    getDoctorLeavesByMonth,
    getBranchDoctorAvailability,
} = require('../../services/doctorLeaveService');

const toPositiveInt = (value) => {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) {
        return null;
    }

    return parsed;
};

const getClientIp = (req) => {
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) {
        return forwarded.split(',')[0].trim();
    }

    return req.ip || req.socket?.remoteAddress || '0.0.0.0';
};

const listDoctorLeaves = asyncHandler(async (req, res) => {
    const branchId = req.query?.branch_id !== undefined ? toPositiveInt(req.query.branch_id) : req.selectedBranchId;
    const month = req.query?.month ? String(req.query.month).trim() : getCurrentMonthString();

    if (!branchId) {
        throw new AppError('branch_id must be a positive integer', 400);
    }

    const result = await getDoctorLeavesByMonth({
        doctorId: req.user.id,
        branchId,
        month,
    });

    return res.status(200).json({
        success: true,
        message: 'Doctor leave calendar fetched successfully',
        data: result.data,
        meta: {
            month: result.month,
            branch_id: branchId,
            total: result.data.length,
        },
    });
});

const saveDoctorLeave = asyncHandler(async (req, res) => {
    const branchId = req.body?.branch_id !== undefined ? toPositiveInt(req.body.branch_id) : req.selectedBranchId;
    const leaveDate = req.body?.leave_date ? String(req.body.leave_date).trim() : '';
    const leaveReason = req.body?.leave_reason ? String(req.body.leave_reason).trim() : null;

    if (!branchId) {
        throw new AppError('branch_id must be a positive integer', 400);
    }

    if (!leaveDate) {
        throw new AppError('leave_date is required', 400);
    }

    const leave = await createDoctorLeave({
        doctorId: req.user.id,
        branchId,
        leaveDate,
        leaveReason,
        actorUserId: req.user.id,
        actorRole: req.user.role_code,
        actorIp: getClientIp(req),
    });

    return res.status(201).json({
        success: true,
        message: 'Doctor leave saved successfully',
        data: leave,
    });
});

const removeDoctorLeave = asyncHandler(async (req, res) => {
    const leaveId = toPositiveInt(req.params.leave_id);

    if (!leaveId) {
        throw new AppError('Valid leave_id is required', 400);
    }

    const leave = await cancelDoctorLeave({
        leaveId,
        doctorId: req.user.id,
        actorUserId: req.user.id,
        actorRole: req.user.role_code,
        actorIp: getClientIp(req),
    });

    return res.status(200).json({
        success: true,
        message: 'Doctor leave cancelled successfully',
        data: leave,
    });
});

const saveDoctorLeavesBulk = asyncHandler(async (req, res) => {
    const branchId = req.body?.branch_id !== undefined ? toPositiveInt(req.body.branch_id) : req.selectedBranchId;
    const leaveDates = Array.isArray(req.body?.leave_dates) ? req.body.leave_dates : [];
    const leaveReason = req.body?.leave_reason ? String(req.body.leave_reason).trim() : null;

    if (!branchId) {
        throw new AppError('branch_id must be a positive integer', 400);
    }

    const result = await createDoctorLeavesBulk({
        doctorId: req.user.id,
        branchId,
        leaveDates,
        leaveReason,
        actorUserId: req.user.id,
        actorIp: getClientIp(req),
    });

    return res.status(200).json({
        success: true,
        message: 'Doctor leave dates saved successfully',
        data: result,
    });
});

const removeDoctorLeavesBulk = asyncHandler(async (req, res) => {
    const branchId = req.body?.branch_id !== undefined ? toPositiveInt(req.body.branch_id) : req.selectedBranchId;
    const leaveDates = Array.isArray(req.body?.leave_dates) ? req.body.leave_dates : [];

    if (!branchId) {
        throw new AppError('branch_id must be a positive integer', 400);
    }

    const result = await cancelDoctorLeavesBulk({
        doctorId: req.user.id,
        branchId,
        leaveDates,
        actorUserId: req.user.id,
        actorRole: req.user.role_code,
        actorIp: getClientIp(req),
    });

    return res.status(200).json({
        success: true,
        message: 'Doctor leave dates cancelled successfully',
        data: result,
    });
});

const getPublicDoctorBookingAvailability = asyncHandler(async (req, res) => {
    const branchId = req.query?.branch_id !== undefined ? toPositiveInt(req.query.branch_id) : null;
    const appointmentDate = req.query?.date ? String(req.query.date).trim() : '';

    if (!branchId) {
        throw new AppError('branch_id must be a positive integer', 400);
    }

    if (!appointmentDate) {
        throw new AppError('date is required', 400);
    }

    const availability = await getBranchDoctorAvailability({
        branchId,
        appointmentDate,
    });

    return res.status(200).json({
        success: true,
        message: 'Doctor booking availability fetched successfully',
        data: availability,
    });
});

module.exports = {
    listDoctorLeaves,
    saveDoctorLeave,
    removeDoctorLeave,
    saveDoctorLeavesBulk,
    removeDoctorLeavesBulk,
    getPublicDoctorBookingAvailability,
};
