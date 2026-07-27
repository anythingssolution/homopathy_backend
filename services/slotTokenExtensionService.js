const AppError = require('../utils/AppError');
const {
    buildSlotTokenPlate,
} = require('../utils/appointmentTokens');
const { resolveEffectiveSlotTiming } = require('./slotTimeOverrideService');

const EXTENSION_DURATION_SECONDS = 60 * 60;
const MAX_EXTENSION_BLOCKS = 4;
const ACTIVE_STATUS = 'ACTIVE';
const TREATMENT_COLORS = {
    ACUTE_TREATMENT: '#F97316',
    FIRST_CONSULTATION: '#2563EB',
    FOLLOW_UP_VISIT: '#16A34A',
    CHRONIC_CASE_DISCUSSION: '#7C3AED',
};

const executeRows = async (executor, sql, params = []) => {
    if (typeof executor === 'function') {
        return executor(sql, params);
    }

    const [rows] = await executor.execute(sql, params);
    return rows;
};

const parseTimeToSeconds = (value) => {
    const match = String(value || '').match(/^(\d{2}):(\d{2})(?::(\d{2}))?$/);
    if (!match) {
        return null;
    }

    return (Number(match[1]) * 3600) + (Number(match[2]) * 60) + Number(match[3] || 0);
};

const formatSecondsToTime = (value) => {
    const seconds = Math.max(0, Math.round(Number(value) || 0));
    const normalized = seconds % (24 * 3600);
    const hours = Math.floor(normalized / 3600);
    const minutes = Math.floor((normalized % 3600) / 60);
    const remainingSeconds = normalized % 60;

    return [hours, minutes, remainingSeconds]
        .map((part) => String(part).padStart(2, '0'))
        .join(':');
};

const loadExtensionMix = async (executor) => executeRows(
    executor,
    `SELECT
        m.fk_treatment_id,
        m.token_count,
        m.display_order,
        t.treatment_code,
        t.treatment_name,
        t.estimated_duration_minutes
     FROM master_token_extension_mix m
     JOIN master_treatments t ON t.id = m.fk_treatment_id
     WHERE m.is_active = 1
       AND t.is_active = 1
     ORDER BY m.display_order ASC, m.id ASC`
);

const expandExtensionMix = (mixRows) => {
    const expanded = [];
    mixRows.forEach((row) => {
        for (let index = 0; index < Number(row.token_count); index += 1) {
            expanded.push(row);
        }
    });
    return expanded;
};

const loadOrderedExtensionMix = async (executor, branchId) => {
    const mixRows = await loadExtensionMix(executor);
    const rowsByCode = new Map(mixRows.map((row) => [row.treatment_code, row]));
    const savedLayout = await executeRows(
        executor,
        `SELECT sequence_number, treatment_code
         FROM tbl_branch_extension_token_layouts
         WHERE fk_branch_id = ?
         ORDER BY sequence_number ASC`,
        [branchId]
    );
    const expectedCount = mixRows.reduce((total, row) => total + Number(row.token_count), 0);
    if (savedLayout.length !== expectedCount) {
        return expandExtensionMix(mixRows);
    }

    const orderedRows = savedLayout.map((item) => rowsByCode.get(item.treatment_code)).filter(Boolean);
    const actualCounts = orderedRows.reduce((counts, row) => {
        counts[row.treatment_code] = (counts[row.treatment_code] || 0) + 1;
        return counts;
    }, {});
    const isValid = orderedRows.length === expectedCount && mixRows.every(
        (row) => actualCounts[row.treatment_code] === Number(row.token_count)
    );

    return isValid ? orderedRows : expandExtensionMix(mixRows);
};

const buildExtensionTokens = ({ basePlate, mixRows, blockNumber }) => {
    if (!Array.isArray(basePlate) || basePlate.length === 0) {
        throw new AppError('Base token plate is unavailable', 409);
    }

    const normalizedMix = mixRows.map((row) => {
        const durationSeconds = Math.round(Number(row.estimated_duration_minutes) * 60);
        const tokenCount = Number(row.token_count);

        if (!row.treatment_code || !Number.isInteger(tokenCount) || tokenCount <= 0 || durationSeconds <= 0) {
            throw new AppError('Extra-token treatment configuration is invalid', 409);
        }

        return {
            ...row,
            token_count: tokenCount,
            duration_seconds: durationSeconds,
        };
    });

    const totalDurationSeconds = normalizedMix.reduce(
        (total, row) => total + row.duration_seconds,
        0
    );

    if (totalDurationSeconds !== EXTENSION_DURATION_SECONDS) {
        throw new AppError(
            `Extra-token treatment mix must total exactly 60 minutes; current total is ${totalDurationSeconds / 60} minutes`,
            409
        );
    }

    const lastBaseToken = basePlate[basePlate.length - 1];
    let cursorSeconds = parseTimeToSeconds(lastBaseToken.estimated_end_at);
    if (cursorSeconds === null) {
        throw new AppError('Base token plate end time is invalid', 409);
    }

    const tokens = [];
    normalizedMix.forEach((row) => {
            const tokenNumber = basePlate.length + tokens.length + 1;
            const startSeconds = cursorSeconds;
            const endSeconds = startSeconds + row.duration_seconds;

            tokens.push({
                token_number: tokenNumber,
                sequence_number: tokens.length + 1,
                treatment_id: Number(row.fk_treatment_id),
                visit_type_code: row.treatment_code,
                visit_type_label: row.treatment_name,
                short_label: row.treatment_name
                    .replace(' Consultation', '')
                    .replace(' Treatment', '')
                    .replace(' Visit', ''),
                duration_seconds: row.duration_seconds,
                duration_minutes: row.duration_seconds / 60,
                estimated_start_at: formatSecondsToTime(startSeconds),
                estimated_end_at: formatSecondsToTime(endSeconds),
                color_code: TREATMENT_COLORS[row.treatment_code] || '#549E9E',
                is_extra: true,
                extension_block_number: blockNumber,
            });
            cursorSeconds = endSeconds;
    });

    return {
        tokens,
        totalDurationSeconds,
        mix: Array.from(new Map(normalizedMix.map((row) => [row.treatment_code, row])).values()).map((row) => ({
            treatment_id: Number(row.fk_treatment_id),
            treatment_code: row.treatment_code,
            treatment_name: row.treatment_name,
            token_count: normalizedMix.filter((item) => item.treatment_code === row.treatment_code).length,
            duration_minutes: row.duration_seconds / 60,
            allocated_minutes: (
                normalizedMix.filter((item) => item.treatment_code === row.treatment_code).length
                * row.duration_seconds
            ) / 60,
        })),
    };
};

const buildExtensionPreview = async ({
    executor,
    branchId,
    slotId,
    appointmentDate,
    slotStartTime,
}) => {
    const timing = await resolveEffectiveSlotTiming({
        executor,
        branchId,
        slotId,
        appointmentDate,
    });
    const basePlate = buildSlotTokenPlate({
        branchId,
        slotId,
        appointmentDate,
        slotStartTime: timing.effectiveStartTime || slotStartTime,
    });
    const activeExtensions = await loadActiveExtensions(executor, {
        branchId,
        slotId,
        appointmentDate,
    });
    if (activeExtensions.length >= MAX_EXTENSION_BLOCKS) {
        throw new AppError(`Maximum ${MAX_EXTENSION_BLOCKS} extra one-hour blocks are already active`, 409);
    }

    const existingExtensionTokens = [];
    for (const activeExtension of activeExtensions) {
        const rows = await loadExtensionTokens(executor, activeExtension.id);
        existingExtensionTokens.push(...rows.map((row) => ({
            token_number: Number(row.token_number),
            estimated_end_at: String(row.estimated_end_time),
        })));
    }
    const effectivePlate = [...basePlate, ...existingExtensionTokens];
    const blockNumber = activeExtensions.length + 1;
    const mixRows = await loadOrderedExtensionMix(executor, branchId);
    const extension = buildExtensionTokens({
        basePlate: effectivePlate,
        mixRows,
        blockNumber,
    });

    return {
        base_token_count: basePlate.length,
        existing_extra_token_count: existingExtensionTokens.length,
        active_block_count: activeExtensions.length,
        block_number: blockNumber,
        max_blocks: MAX_EXTENSION_BLOCKS,
        extra_token_count: extension.tokens.length,
        effective_token_count: effectivePlate.length + extension.tokens.length,
        total_duration_seconds: extension.totalDurationSeconds,
        total_duration_minutes: extension.totalDurationSeconds / 60,
        token_range: {
            from: extension.tokens[0]?.token_number || null,
            to: extension.tokens[extension.tokens.length - 1]?.token_number || null,
        },
        mix: extension.mix,
        tokens: extension.tokens,
    };
};

const loadActiveExtensions = async (executor, { branchId, slotId, appointmentDate, lock = false }) => {
    const rows = await executeRows(
        executor,
        `SELECT *
         FROM tbl_slot_token_extensions
         WHERE fk_branch_id = ?
           AND fk_slot_id = ?
           AND appointment_date = ?
           AND status = ?
         ORDER BY block_number ASC${lock ? ' FOR UPDATE' : ''}`,
        [branchId, slotId, appointmentDate, ACTIVE_STATUS]
    );

    return rows;
};

const loadActiveExtension = async (executor, context) => (
    (await loadActiveExtensions(executor, context))[0] || null
);

const loadExtensionTokens = async (executor, extensionId) => executeRows(
    executor,
    `SELECT
        token_number,
        sequence_number,
        fk_treatment_id AS treatment_id,
        treatment_code_snapshot AS visit_type_code,
        treatment_name_snapshot AS visit_type_label,
        duration_seconds,
        estimated_start_time,
        estimated_end_time
     FROM tbl_slot_extension_tokens
     WHERE fk_extension_id = ?
     ORDER BY sequence_number ASC`,
    [extensionId]
);

const buildEffectiveSlotTokenPlate = async ({
    executor,
    branchId,
    slotId,
    appointmentDate,
    slotStartTime,
    bookedTokenNumbers = new Set(),
    selectedVisitTypeCode = null,
    delayMinutes = 0,
}) => {
    const timing = await resolveEffectiveSlotTiming({
        executor,
        branchId,
        slotId,
        appointmentDate,
    });
    const basePlate = buildSlotTokenPlate({
        branchId,
        slotId,
        appointmentDate,
        slotStartTime: timing.effectiveStartTime || slotStartTime,
        bookedTokenNumbers,
        selectedVisitTypeCode,
        delayMinutes,
    });
    const extensions = await loadActiveExtensions(executor, { branchId, slotId, appointmentDate });
    if (extensions.length === 0) {
        return basePlate;
    }

    const extensionTokens = [];
    for (const extension of extensions) {
        const rows = await loadExtensionTokens(executor, extension.id);
        extensionTokens.push(...rows.map((row) => {
        const tokenNumber = Number(row.token_number);
        const isBooked = bookedTokenNumbers.has(tokenNumber);
        const isTypeMatch = !selectedVisitTypeCode || selectedVisitTypeCode === row.visit_type_code;

        return {
            token_number: tokenNumber,
            visit_type_code: row.visit_type_code,
            visit_type_label: row.visit_type_label,
            short_label: row.visit_type_label
                .replace(' Consultation', '')
                .replace(' Treatment', '')
                .replace(' Visit', ''),
            duration_minutes: Number(row.duration_seconds) / 60,
            estimated_start_at: String(row.estimated_start_time),
            estimated_end_at: String(row.estimated_end_time),
            color_code: TREATMENT_COLORS[row.visit_type_code] || '#549E9E',
            is_extra: true,
            extension_block_number: Number(extension.block_number),
            is_booked: isBooked,
            is_selectable: !isBooked && isTypeMatch,
            selection_disabled_reason: isBooked
                ? 'Already booked'
                : (isTypeMatch ? null : `Reserved for ${row.visit_type_label}`),
        };
        }));
    }

    return [...basePlate, ...extensionTokens];
};

module.exports = {
    EXTENSION_DURATION_SECONDS,
    MAX_EXTENSION_BLOCKS,
    buildExtensionPreview,
    buildEffectiveSlotTokenPlate,
    loadActiveExtension,
    loadActiveExtensions,
    loadExtensionTokens,
    formatSecondsToTime,
};
