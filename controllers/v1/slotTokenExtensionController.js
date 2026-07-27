const { query, withTransaction } = require('../../config/db');
const AppError = require('../../utils/AppError');
const asyncHandler = require('../../utils/asyncHandler');
const {
    buildExtensionPreview,
    MAX_EXTENSION_BLOCKS,
    loadActiveExtensions,
    loadExtensionTokens,
} = require('../../services/slotTokenExtensionService');
const { resolveEffectiveSlotTiming } = require('../../services/slotTimeOverrideService');

const toPositiveInt = (value) => {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

const isValidDateString = (value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));

const getTodayDateString = () => {
    const now = new Date();
    return [
        now.getFullYear(),
        String(now.getMonth() + 1).padStart(2, '0'),
        String(now.getDate()).padStart(2, '0'),
    ].join('-');
};

const getClientIp = (req) => {
    const forwarded = req.headers['x-forwarded-for'];
    return forwarded ? forwarded.split(',')[0].trim() : (req.ip || req.socket?.remoteAddress || null);
};

const writeRejectedAudit = async ({
    action,
    req,
    extensionId = null,
    payload = null,
    error,
}) => {
    try {
        await query(
            `INSERT INTO tbl_slot_token_extension_audit_logs
             (fk_extension_id, action, new_data_json, performed_by,
              performed_by_role, ip_address)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [
                extensionId,
                action,
                JSON.stringify({
                    request: payload,
                    error: error?.message || 'Request rejected',
                }),
                Number(req.user.id),
                String(req.user.role || req.user.role_code || 'REC'),
                getClientIp(req),
            ]
        );
    } catch (auditError) {
        console.error('Failed to write slot extension rejection audit:', auditError);
    }
};

const resolveContext = async ({ executor, branchId, slotId }) => {
    const rows = await (typeof executor === 'function'
        ? executor(
            `SELECT
                b.id AS branch_id,
                b.branch_name,
                s.id AS slot_id,
                s.slot_name,
                s.start_time,
                s.end_time
             FROM master_clinic_branches b
             JOIN master_slots s ON s.fk_branch_id = b.id
             WHERE b.id = ?
               AND s.id = ?
               AND b.is_active = 1
               AND s.is_active = 1
             LIMIT 1`,
            [branchId, slotId]
        )
        : executor.execute(
            `SELECT
                b.id AS branch_id,
                b.branch_name,
                s.id AS slot_id,
                s.slot_name,
                s.start_time,
                s.end_time
             FROM master_clinic_branches b
             JOIN master_slots s ON s.fk_branch_id = b.id
             WHERE b.id = ?
               AND s.id = ?
               AND b.is_active = 1
               AND s.is_active = 1
             LIMIT 1`,
            [branchId, slotId]
        ).then(([result]) => result));

    if (rows.length === 0) {
        throw new AppError('Selected branch or slot is inactive or invalid', 404);
    }

    return rows[0];
};

const parseRequestContext = (req) => {
    const branchId = toPositiveInt(req.selectedBranchId || req.query.branch_id || req.body.branch_id);
    const slotId = toPositiveInt(req.query.slot_id || req.body.slot_id);
    const appointmentDate = String(req.query.appointment_date || req.body.appointment_date || '').trim();

    if (!branchId || !slotId || !isValidDateString(appointmentDate)) {
        throw new AppError('branch_id, slot_id and appointment_date (YYYY-MM-DD) are required', 400);
    }

    if (appointmentDate < getTodayDateString()) {
        throw new AppError('Extra tokens cannot be created for a past date', 400);
    }

    return { branchId, slotId, appointmentDate };
};

const getExtensionPreview = asyncHandler(async (req, res) => {
    const context = parseRequestContext(req);
    const slot = await resolveContext({ executor: query, ...context });
    const activeExtensions = await loadActiveExtensions(query, context);
    const timing = await resolveEffectiveSlotTiming({ executor: query, ...context });
    const preview = await buildExtensionPreview({
        executor: query,
        ...context,
        slotStartTime: timing.effectiveStartTime,
    });

    return res.status(200).json({
        success: true,
        message: `Extra-token block ${preview.block_number} preview generated successfully`,
        data: {
            branch: {
                id: Number(slot.branch_id),
                branch_name: slot.branch_name,
            },
            slot: {
                id: Number(slot.slot_id),
                slot_name: slot.slot_name,
                start_time: timing.effectiveStartTime,
                end_time: timing.effectiveEndTime,
                default_start_time: timing.defaultStartTime,
                default_end_time: timing.defaultEndTime,
                has_time_override: timing.hasOverride,
            },
            appointment_date: context.appointmentDate,
            active_extensions: activeExtensions,
            can_create: activeExtensions.length < MAX_EXTENSION_BLOCKS,
            ...preview,
        },
    });
});

const createExtension = asyncHandler(async (req, res) => {
    const context = parseRequestContext(req);
    const actorId = Number(req.user.id);
    const actorRole = String(req.user.role || req.user.role_code || 'REC');
    const ipAddress = getClientIp(req);

    let created;
    try {
        created = await withTransaction(async (connection) => {
            const slot = await resolveContext({ executor: connection, ...context });
            const activeExtensions = await loadActiveExtensions(connection, { ...context, lock: true });
            if (activeExtensions.length >= MAX_EXTENSION_BLOCKS) {
                throw new AppError(`Maximum ${MAX_EXTENSION_BLOCKS} extra one-hour blocks are allowed`, 409);
            }

            const timing = await resolveEffectiveSlotTiming({ executor: connection, ...context });
            const preview = await buildExtensionPreview({
                executor: connection,
                ...context,
                slotStartTime: timing.effectiveStartTime,
            });

            const [headerResult] = await connection.execute(
                `INSERT INTO tbl_slot_token_extensions
                 (fk_branch_id, fk_slot_id, appointment_date, base_token_count,
                  block_number, extra_token_count, total_duration_seconds, status, created_by, created_ip)
                 VALUES (?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?)`,
                [
                    context.branchId,
                    context.slotId,
                    context.appointmentDate,
                    preview.token_range.from - 1,
                    preview.block_number,
                    preview.extra_token_count,
                    preview.total_duration_seconds,
                    actorId,
                    ipAddress,
                ]
            );
            const extensionId = Number(headerResult.insertId);

            for (const token of preview.tokens) {
                await connection.execute(
                    `INSERT INTO tbl_slot_extension_tokens
                     (fk_extension_id, token_number, sequence_number, fk_treatment_id,
                      treatment_code_snapshot, treatment_name_snapshot, duration_seconds,
                      estimated_start_time, estimated_end_time)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    [
                        extensionId,
                        token.token_number,
                        token.sequence_number,
                        token.treatment_id,
                        token.visit_type_code,
                        token.visit_type_label,
                        token.duration_seconds,
                        token.estimated_start_at,
                        token.estimated_end_at,
                    ]
                );
            }

            await connection.execute(
                `INSERT INTO tbl_slot_token_extension_audit_logs
                 (fk_extension_id, action, new_data_json, performed_by, performed_by_role, ip_address)
                 VALUES (?, 'CREATED', ?, ?, ?, ?)`,
                [extensionId, JSON.stringify(preview), actorId, actorRole, ipAddress]
            );

            return { extensionId, preview, slot };
        });
    } catch (error) {
        await writeRejectedAudit({
            action: 'CREATE_REJECTED',
            req,
            payload: context,
            error,
        });
        throw error;
    }

    return res.status(201).json({
        success: true,
        message: 'Extra 1-hour token block created successfully',
        data: {
            extension_id: created.extensionId,
            appointment_date: context.appointmentDate,
            branch_id: context.branchId,
            slot_id: context.slotId,
            ...created.preview,
        },
    });
});

const listExtensions = asyncHandler(async (req, res) => {
    const branchId = toPositiveInt(req.selectedBranchId || req.query.branch_id);
    if (!branchId) {
        throw new AppError('branch_id is required', 400);
    }

    const appointmentDate = req.query.appointment_date
        ? String(req.query.appointment_date).trim()
        : null;
    const params = [branchId];
    let dateFilter = '';
    if (appointmentDate) {
        if (!isValidDateString(appointmentDate)) {
            throw new AppError('appointment_date must be in YYYY-MM-DD format', 400);
        }
        dateFilter = ' AND e.appointment_date = ?';
        params.push(appointmentDate);
    }

    const rows = await query(
        `SELECT
            e.*,
            b.branch_name,
            s.slot_name,
            COALESCE(sto.override_start_time, s.start_time) AS start_time,
            COALESCE(sto.override_end_time, s.end_time) AS end_time,
            (
              SELECT COUNT(*)
              FROM tbl_appointments a
              WHERE a.fk_branch_id = e.fk_branch_id
                AND a.fk_slot_id = e.fk_slot_id
                AND a.appointment_date = e.appointment_date
                AND a.token_number > e.base_token_count
                AND a.token_number <= e.base_token_count + e.extra_token_count
                AND a.is_active = 1
                AND a.status <> 'Cancelled'
                AND COALESCE(a.reception_status, '') <> 'REJECTED_BY_RECEPTION'
                AND COALESCE(a.queue_status, '') <> 'CANCELLED'
            ) AS booked_extra_tokens
         FROM tbl_slot_token_extensions e
         JOIN master_clinic_branches b ON b.id = e.fk_branch_id
         JOIN master_slots s ON s.id = e.fk_slot_id
         LEFT JOIN tbl_doctor_slot_time_overrides sto
           ON sto.fk_branch_id = e.fk_branch_id
          AND sto.fk_slot_id = e.fk_slot_id
          AND sto.appointment_date = e.appointment_date
          AND sto.status = 'ACTIVE'
         WHERE e.fk_branch_id = ?${dateFilter}
         ORDER BY e.appointment_date DESC, s.start_time ASC, e.block_number ASC, e.created_at DESC`,
        params
    );

    return res.status(200).json({
        success: true,
        message: 'Slot token extensions fetched successfully',
        data: rows,
    });
});

const getExtensionDetail = asyncHandler(async (req, res) => {
    const extensionId = toPositiveInt(req.params.extension_id);
    const branchId = toPositiveInt(req.selectedBranchId);
    if (!extensionId || !branchId) {
        throw new AppError('Valid extension_id and selected branch are required', 400);
    }

    const rows = await query(
        `SELECT e.*, b.branch_name, s.slot_name,
                 COALESCE(sto.override_start_time, s.start_time) AS start_time,
                 COALESCE(sto.override_end_time, s.end_time) AS end_time
         FROM tbl_slot_token_extensions e
         JOIN master_clinic_branches b ON b.id = e.fk_branch_id
         JOIN master_slots s ON s.id = e.fk_slot_id
         LEFT JOIN tbl_doctor_slot_time_overrides sto
           ON sto.fk_branch_id = e.fk_branch_id
          AND sto.fk_slot_id = e.fk_slot_id
          AND sto.appointment_date = e.appointment_date
          AND sto.status = 'ACTIVE'
         WHERE e.id = ? AND e.fk_branch_id = ?
         LIMIT 1`,
        [extensionId, branchId]
    );
    if (rows.length === 0) {
        throw new AppError('Extra-token block not found', 404);
    }

    const tokens = await loadExtensionTokens(query, extensionId);
    const audit = await query(
        `SELECT action, old_data_json, new_data_json, performed_by,
                performed_by_role, performed_at, ip_address
         FROM tbl_slot_token_extension_audit_logs
         WHERE fk_extension_id = ?
         ORDER BY performed_at DESC, id DESC`,
        [extensionId]
    );

    return res.status(200).json({
        success: true,
        message: 'Extra-token block fetched successfully',
        data: { ...rows[0], tokens, audit },
    });
});

const cancelExtension = asyncHandler(async (req, res) => {
    const extensionId = toPositiveInt(req.params.extension_id);
    const branchId = toPositiveInt(req.selectedBranchId || req.body.branch_id);
    const reason = String(req.body.reason || '').trim();
    if (!extensionId || !branchId) {
        throw new AppError('Valid extension_id and selected branch are required', 400);
    }
    if (!reason) {
        throw new AppError('Cancellation reason is required', 400);
    }

    const actorId = Number(req.user.id);
    const actorRole = String(req.user.role || req.user.role_code || 'REC');
    const ipAddress = getClientIp(req);

    try {
        await withTransaction(async (connection) => {
            const [rows] = await connection.execute(
            `SELECT *
             FROM tbl_slot_token_extensions
             WHERE id = ? AND fk_branch_id = ? AND status = 'ACTIVE'
             LIMIT 1
             FOR UPDATE`,
            [extensionId, branchId]
        );
            if (rows.length === 0) {
                throw new AppError('Active extra-token block not found', 404);
            }
            const extension = rows[0];

            const [laterBlocks] = await connection.execute(
                `SELECT id
                 FROM tbl_slot_token_extensions
                 WHERE fk_branch_id = ?
                   AND fk_slot_id = ?
                   AND appointment_date = ?
                   AND status = 'ACTIVE'
                   AND block_number > ?
                 LIMIT 1
                 FOR UPDATE`,
                [
                    extension.fk_branch_id,
                    extension.fk_slot_id,
                    extension.appointment_date,
                    extension.block_number,
                ]
            );
            if (laterBlocks.length > 0) {
                throw new AppError('Cancel the latest extra-hour block first', 409);
            }

            const [bookedRows] = await connection.execute(
            `SELECT COUNT(*) AS total
             FROM tbl_appointments
             WHERE fk_branch_id = ?
               AND fk_slot_id = ?
               AND appointment_date = ?
               AND token_number > ?
               AND token_number <= ?
               AND is_active = 1
               AND status <> 'Cancelled'
               AND COALESCE(reception_status, '') <> 'REJECTED_BY_RECEPTION'
               AND COALESCE(queue_status, '') <> 'CANCELLED'
             FOR UPDATE`,
            [
                extension.fk_branch_id,
                extension.fk_slot_id,
                extension.appointment_date,
                extension.base_token_count,
                Number(extension.base_token_count) + Number(extension.extra_token_count),
            ]
        );
            if (Number(bookedRows[0].total) > 0) {
                throw new AppError('Extra-token block cannot be cancelled while an extra token is booked', 409);
            }

            await connection.execute(
            `UPDATE tbl_slot_token_extensions
             SET status = 'CANCELLED',
                 cancelled_by = ?,
                 cancelled_at = NOW(),
                 cancellation_reason = ?
             WHERE id = ?`,
            [actorId, reason.slice(0, 500), extensionId]
        );
            await connection.execute(
            `INSERT INTO tbl_slot_token_extension_audit_logs
             (fk_extension_id, action, old_data_json, new_data_json,
              performed_by, performed_by_role, ip_address)
             VALUES (?, 'CANCELLED', ?, ?, ?, ?, ?)`,
            [
                extensionId,
                JSON.stringify(extension),
                JSON.stringify({ status: 'CANCELLED', reason }),
                actorId,
                actorRole,
                ipAddress,
            ]
            );
        });
    } catch (error) {
        await writeRejectedAudit({
            action: 'CANCEL_REJECTED',
            req,
            extensionId,
            payload: { branch_id: branchId, reason },
            error,
        });
        throw error;
    }

    return res.status(200).json({
        success: true,
        message: 'Extra-token block cancelled successfully',
    });
});

module.exports = {
    getExtensionPreview,
    createExtension,
    listExtensions,
    getExtensionDetail,
    cancelExtension,
};
