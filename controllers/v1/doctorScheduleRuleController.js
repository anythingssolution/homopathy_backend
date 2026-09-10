const AppError = require('../../utils/AppError');
const asyncHandler = require('../../utils/asyncHandler');
const {
    createRecurringRule,
    deactivateRecurringRule,
    listRecurringRules,
    listRulesForBranchDate,
    updateRecurringRule,
} = require('../../services/recurringScheduleService');

const toPositiveInt = (value) => {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};
const isValidDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
const getClientIp = (req) => {
    const forwarded = req.headers['x-forwarded-for'];
    return forwarded ? forwarded.split(',')[0].trim() : (req.ip || req.socket?.remoteAddress || null);
};

const resolveBranchId = (req) => {
    const branchId = toPositiveInt(req.selectedBranchId || req.query.branch_id || req.body?.branch_id);
    if (!branchId) {
        throw new AppError('branch_id is required', 400);
    }
    return branchId;
};

const buildSyncMessage = (verb, sync) => {
    if (!sync) {
        return `Weekly rule ${verb}.`;
    }
    const parts = [`Weekly rule ${verb}.`];
    if (sync.updated > 0) {
        parts.push(`${sync.updated} upcoming date${sync.updated === 1 ? '' : 's'} updated.`);
    }
    if (sync.skipped.length > 0) {
        parts.push(`${sync.skipped.length} date${sync.skipped.length === 1 ? '' : 's'} skipped (queue already started).`);
    }
    return parts.join(' ');
};

const listDoctorScheduleRules = asyncHandler(async (req, res) => {
    const branchId = resolveBranchId(req);
    const includeInactive = ['1', 'true'].includes(String(req.query.include_inactive || '').toLowerCase());
    const { rules, slots } = await listRecurringRules({ branchId, includeInactive });

    return res.status(200).json({
        success: true,
        message: 'Weekly schedule rules fetched successfully',
        data: rules,
        meta: { branch_id: branchId, slots },
    });
});

const createDoctorScheduleRule = asyncHandler(async (req, res) => {
    const branchId = resolveBranchId(req);
    const { rule, sync } = await createRecurringRule({
        branchId,
        slotId: req.body?.slot_id ?? null,
        dayOfWeek: req.body?.day_of_week,
        startTime: req.body?.start_time,
        description: req.body?.description,
        actorUserId: req.user.id,
        ip: getClientIp(req),
    });

    return res.status(201).json({
        success: true,
        message: buildSyncMessage('created', sync),
        data: rule,
        meta: { sync },
    });
});

const updateDoctorScheduleRule = asyncHandler(async (req, res) => {
    const branchId = resolveBranchId(req);
    const ruleId = toPositiveInt(req.params.rule_id);
    if (!ruleId) {
        throw new AppError('Valid rule_id is required', 400);
    }

    const { rule, sync } = await updateRecurringRule({
        ruleId,
        branchId,
        slotId: req.body?.slot_id,
        dayOfWeek: req.body?.day_of_week,
        startTime: req.body?.start_time,
        description: req.body?.description,
        actorUserId: req.user.id,
        ip: getClientIp(req),
    });

    return res.status(200).json({
        success: true,
        message: buildSyncMessage('updated', sync),
        data: rule,
        meta: { sync },
    });
});

const removeDoctorScheduleRule = asyncHandler(async (req, res) => {
    const branchId = resolveBranchId(req);
    const ruleId = toPositiveInt(req.params.rule_id);
    if (!ruleId) {
        throw new AppError('Valid rule_id is required', 400);
    }

    const { rule, sync } = await deactivateRecurringRule({
        ruleId,
        branchId,
        actorUserId: req.user.id,
        ip: getClientIp(req),
    });

    return res.status(200).json({
        success: true,
        message: buildSyncMessage('removed', sync),
        data: rule,
        meta: { sync },
    });
});

/** Public, read-only: rules that apply to a branch on a date (for booking / live-queue notes). */
const getPublicScheduleRules = asyncHandler(async (req, res) => {
    const branchId = toPositiveInt(req.query.branch_id);
    const appointmentDate = String(req.query.appointment_date || '').trim();
    if (!branchId) {
        throw new AppError('branch_id is required', 400);
    }
    if (!isValidDate(appointmentDate)) {
        throw new AppError('appointment_date must be in YYYY-MM-DD format', 400);
    }

    const rules = await listRulesForBranchDate({ branchId, appointmentDate });

    return res.status(200).json({
        success: true,
        message: 'Schedule rules fetched successfully',
        data: rules.map((rule) => ({
            id: rule.id,
            slot_id: rule.slot_id,
            slot_name: rule.slot_name,
            applies_to_first_slot: rule.applies_to_first_slot,
            day_of_week: rule.day_of_week,
            day_label: rule.day_label,
            start_time: rule.start_time,
            end_time: rule.end_time,
            description: rule.description,
        })),
        meta: { branch_id: branchId, appointment_date: appointmentDate },
    });
});

module.exports = {
    listDoctorScheduleRules,
    createDoctorScheduleRule,
    updateDoctorScheduleRule,
    removeDoctorScheduleRule,
    getPublicScheduleRules,
};
