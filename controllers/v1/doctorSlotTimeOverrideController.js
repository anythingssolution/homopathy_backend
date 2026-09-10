const { query, withTransaction } = require('../../config/db');
const AppError = require('../../utils/AppError');
const asyncHandler = require('../../utils/asyncHandler');
const {
    buildRecurringRuleReason,
    calculateShiftedTiming,
    findRecurringRuleForSlot,
    resolveEffectiveSlotTiming,
    shiftActiveExtensionTokenTimes,
} = require('../../services/slotTimeOverrideService');
const {
    emitLiveQueueEvent,
    recalculateQueuePlan,
} = require('../../services/liveQueueService');
const {
    assertSlotTimingCanShift,
    cancelSlotOverrideForDate,
    shiftSlotOverrideForDate,
} = require('../../services/recurringScheduleService');

const toPositiveInt = (value) => {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};
const isValidDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
const getToday = () => {
    const date = new Date();
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
};
const getClientIp = (req) => {
    const forwarded = req.headers['x-forwarded-for'];
    return forwarded ? forwarded.split(',')[0].trim() : (req.ip || req.socket?.remoteAddress || null);
};

const parseContext = (req) => {
    const branchId = toPositiveInt(req.selectedBranchId || req.query.branch_id || req.body.branch_id);
    const slotId = toPositiveInt(req.query.slot_id || req.body.slot_id);
    const appointmentDate = String(req.query.appointment_date || req.body.appointment_date || '').trim();
    if (!branchId || !slotId || !isValidDate(appointmentDate)) {
        throw new AppError('branch_id, slot_id and appointment_date (YYYY-MM-DD) are required', 400);
    }
    if (appointmentDate < getToday()) {
        throw new AppError('Past date slot timing cannot be changed', 400);
    }
    return { branchId, slotId, appointmentDate };
};

const assertQueueCanShift = assertSlotTimingCanShift;

const listSlotTimings = asyncHandler(async (req, res) => {
    const branchId = toPositiveInt(req.selectedBranchId || req.query.branch_id);
    const appointmentDate = String(req.query.appointment_date || '').trim();
    if (!branchId || !isValidDate(appointmentDate)) {
        throw new AppError('branch_id and appointment_date (YYYY-MM-DD) are required', 400);
    }

    const slots = await query(
        `SELECT id AS slot_id
         FROM master_slots
         WHERE fk_branch_id = ? AND is_active = 1
         ORDER BY start_time ASC, id ASC`,
        [branchId]
    );

    // Resolving per slot also materialises any weekly rule for this date, so the doctor sees the
    // real effective time even before the first booking of the day.
    const data = [];
    for (const slot of slots) {
        const timing = await resolveEffectiveSlotTiming({
            executor: query,
            branchId,
            slotId: Number(slot.slot_id),
            appointmentDate,
        });
        data.push({
            slot_id: timing.slotId,
            slot_name: timing.slotName,
            default_start_time: timing.defaultStartTime,
            default_end_time: timing.defaultEndTime,
            effective_start_time: timing.effectiveStartTime,
            effective_end_time: timing.effectiveEndTime,
            override_id: timing.overrideId,
            reason: timing.reason,
            has_override: timing.hasOverride,
            is_recurring_rule: timing.isRecurringRule,
            // Doctor shifted a date that also has a weekly rule (custom time wins for this date).
            is_custom_over_rule: timing.hasOverride && !timing.isRecurringRule && Boolean(timing.recurringRule),
            recurring_rule: timing.recurringRule
                ? {
                    id: timing.recurringRule.id,
                    day_of_week: timing.recurringRule.dayOfWeek,
                    day_label: timing.recurringRule.dayLabel,
                    start_time: timing.recurringRule.startTime,
                    description: timing.recurringRule.description,
                }
                : null,
        });
    }

    return res.status(200).json({
        success: true,
        message: 'Date-wise slot timings fetched successfully',
        data,
    });
});

const saveSlotTiming = asyncHandler(async (req, res) => {
    const context = parseContext(req);
    const overrideStartInput = String(req.body.override_start_time || '').trim();
    const reason = String(req.body.reason || '').trim().slice(0, 500) || null;
    let result;

    result = await withTransaction(async (connection) => {
        await assertQueueCanShift(connection, context);
        const current = await resolveEffectiveSlotTiming({ executor: connection, ...context, lock: true });
        const shifted = calculateShiftedTiming({
            defaultStartTime: current.defaultStartTime,
            defaultEndTime: current.defaultEndTime,
            overrideStartTime: overrideStartInput,
        });
        const previousShift = current.hasOverride
            ? calculateShiftedTiming({
                defaultStartTime: current.defaultStartTime,
                defaultEndTime: current.defaultEndTime,
                overrideStartTime: current.effectiveStartTime,
            }).shiftSeconds
            : 0;
        const deltaSeconds = shifted.shiftSeconds - previousShift;

        const [upsert] = await connection.execute(
            `INSERT INTO tbl_doctor_slot_time_overrides
             (fk_branch_id, fk_slot_id, appointment_date, default_start_time, default_end_time,
              override_start_time, override_end_time, shift_seconds, reason, status,
              created_by, updated_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?)
             ON DUPLICATE KEY UPDATE
               default_start_time = VALUES(default_start_time),
               default_end_time = VALUES(default_end_time),
               override_start_time = VALUES(override_start_time),
               override_end_time = VALUES(override_end_time),
               shift_seconds = VALUES(shift_seconds),
               reason = VALUES(reason),
               status = 'ACTIVE',
               updated_by = VALUES(updated_by),
               cancelled_by = NULL,
               cancelled_at = NULL`,
            [
                context.branchId, context.slotId, context.appointmentDate,
                current.defaultStartTime, current.defaultEndTime,
                shifted.overrideStartTime, shifted.overrideEndTime, shifted.shiftSeconds,
                reason, req.user.id, req.user.id,
            ]
        );
        const overrideId = current.overrideId || upsert.insertId;
        const affectedExtensionTokens = await shiftActiveExtensionTokenTimes({
            connection,
            ...context,
            deltaSeconds,
        });
        const [appointmentRows] = await connection.execute(
            `SELECT COUNT(*) AS total
             FROM tbl_appointments
             WHERE fk_branch_id = ? AND fk_slot_id = ? AND appointment_date = ?
               AND is_active = 1`,
            [context.branchId, context.slotId, context.appointmentDate]
        );

        await recalculateQueuePlan(connection, {
            branchId: context.branchId,
            slotId: context.slotId,
            appointmentDate: context.appointmentDate,
            actorUserId: req.user.id,
        });
        await connection.execute(
            `INSERT INTO tbl_doctor_slot_time_override_audit_logs
             (fk_override_id, fk_branch_id, fk_slot_id, appointment_date, action,
              old_data_json, new_data_json, affected_appointments,
              affected_extension_tokens, performed_by, ip_address)
             VALUES (?, ?, ?, ?, 'UPSERT', ?, ?, ?, ?, ?, ?)`,
            [
                overrideId, context.branchId, context.slotId, context.appointmentDate,
                JSON.stringify(current),
                JSON.stringify(shifted),
                Number(appointmentRows[0].total),
                affectedExtensionTokens,
                req.user.id,
                getClientIp(req),
            ]
        );

        return {
            ...context,
            ...shifted,
            affectedAppointments: Number(appointmentRows[0].total),
            affectedExtensionTokens,
        };
    });

    await emitLiveQueueEvent({
        branchId: context.branchId,
        slotId: context.slotId,
        appointmentDate: context.appointmentDate,
        eventName: 'slot-timing-updated',
        reason: 'DOCTOR_DATE_SLOT_TIME_OVERRIDE',
    });

    return res.status(200).json({
        success: true,
        message: 'Date-wise slot timing updated successfully',
        data: result,
    });
});

const resetSlotTiming = asyncHandler(async (req, res) => {
    const context = parseContext(req);
    const ip = getClientIp(req);

    const result = await withTransaction(async (connection) => {
        // "Reset" means back to the schedule for that day: the weekly rule time when one applies,
        // otherwise the slot's default time.
        const rule = await findRecurringRuleForSlot({ executor: connection, ...context });

        if (rule) {
            const restored = await shiftSlotOverrideForDate(connection, {
                ...context,
                overrideStartTime: String(rule.override_start_time),
                reason: buildRecurringRuleReason(rule),
                actorUserId: req.user.id,
                ip,
                action: 'RESET_TO_WEEKLY_RULE',
            });
            return {
                ...context,
                changed: Boolean(restored),
                restored_to: 'WEEKLY_RULE',
                effective_start_time: restored ? restored.overrideStartTime : String(rule.override_start_time),
            };
        }

        const cancelled = await cancelSlotOverrideForDate(connection, {
            ...context,
            actorUserId: req.user.id,
            ip,
            action: 'RESET',
        });
        return { ...context, changed: Boolean(cancelled), restored_to: 'DEFAULT' };
    });

    if (result.changed) {
        await emitLiveQueueEvent({
            branchId: context.branchId,
            slotId: context.slotId,
            appointmentDate: context.appointmentDate,
            eventName: 'slot-timing-updated',
            reason: 'DOCTOR_DATE_SLOT_TIME_RESET',
        });
    }

    let message;
    if (result.restored_to === 'WEEKLY_RULE') {
        message = result.changed
            ? 'Slot timing restored to the weekly schedule successfully'
            : 'Slot is already following the weekly schedule';
    } else {
        message = result.changed ? 'Slot timing reset to default successfully' : 'Slot is already using default timing';
    }

    return res.status(200).json({
        success: true,
        message,
        data: result,
    });
});

module.exports = {
    listSlotTimings,
    saveSlotTiming,
    resetSlotTiming,
};
