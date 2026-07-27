#!/usr/bin/env node

const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { pool, query } = require('../config/db');
const {
    getCurrentDateTokenList,
    getLiveQueueSnapshot,
} = require('../services/liveQueueService');

const REQUIRED_SCHEMA = {
    tbl_live_queue_sessions: [
        'runtime_anchor_at',
        'last_runtime_recalc_at',
        'auto_call_next_due_at',
        'auto_call_next_reason',
        'queue_revision',
        'session_status',
        'current_appointment_id',
        'current_token_number',
    ],
    tbl_appointments: [
        'current_token_number',
        'original_token_number',
        'queue_status',
        'planned_start_at',
        'planned_end_at',
        'actual_called_at',
        'actual_started_at',
        'actual_completed_at',
        'checked_in_at',
        'arrival_sequence',
        'live_estimated_start_at',
        'live_estimated_end_at',
        'live_wait_minutes_snapshot',
        'live_eta_updated_at',
        'assigned_slot_duration_minutes',
        'assigned_visit_type_code',
    ],
    master_treatments: [
        'treatment_code',
        'estimated_duration_minutes',
    ],
    master_slots: [
        'default_consult_minutes',
    ],
    tbl_doctor_slot_time_overrides: [
        'fk_branch_id',
        'fk_slot_id',
        'appointment_date',
        'override_start_time',
        'override_end_time',
        'status',
    ],
    master_token_extension_mix: [
        'fk_treatment_id',
        'token_count',
        'display_order',
        'is_active',
    ],
    tbl_slot_token_extensions: [
        'fk_branch_id',
        'fk_slot_id',
        'appointment_date',
        'block_number',
        'base_token_count',
        'extra_token_count',
        'total_duration_seconds',
        'status',
    ],
    tbl_slot_extension_tokens: [
        'fk_extension_id',
        'token_number',
        'sequence_number',
        'fk_treatment_id',
        'treatment_code_snapshot',
        'duration_seconds',
        'estimated_start_time',
        'estimated_end_time',
    ],
    tbl_slot_token_extension_audit_logs: [
        'fk_extension_id',
        'action',
        'old_data_json',
        'new_data_json',
        'performed_by',
    ],
};

const parseArgs = () => process.argv.slice(2).reduce((acc, arg) => {
    const match = arg.match(/^--([^=]+)=(.*)$/);
    if (!match) {
        return acc;
    }

    acc[match[1].replace(/-([a-z])/g, (_, char) => char.toUpperCase())] = match[2];
    return acc;
}, {});

const normalizeDateValue = (value) => {
    if (!value) {
        return null;
    }

    if (value instanceof Date) {
        return [
            value.getFullYear(),
            String(value.getMonth() + 1).padStart(2, '0'),
            String(value.getDate()).padStart(2, '0'),
        ].join('-');
    }

    return String(value).slice(0, 10);
};

const expectedTokenPrefix = ({ slotName = null, startTime = null } = {}) => {
    const normalizedSlotName = String(slotName || '').toLowerCase();

    if (normalizedSlotName.includes('morning')) {
        return 'M';
    }

    if (
        normalizedSlotName.includes('evening')
        || normalizedSlotName.includes('afternoon')
        || normalizedSlotName.includes('night')
    ) {
        return 'E';
    }

    const hour = Number(String(startTime || '').slice(0, 2));
    if (!Number.isInteger(hour)) {
        return null;
    }

    return hour < 12 ? 'M' : 'E';
};

const compactToken = (item) => {
    if (!item) {
        return null;
    }

    return {
        appointment_id: item.appointment_id,
        display_token_display: item.display_token_display,
        queue_status: item.queue_status,
        queue_bucket: item.queue_bucket,
        live_estimated_start_at: item.live_estimated_start_at,
        live_estimated_end_at: item.live_estimated_end_at,
        current_queue_start_at: item.current_queue_start_at,
        current_queue_end_at: item.current_queue_end_at,
    };
};

const checkSchema = async () => {
    const databaseName = process.env.DB_NAME;
    const report = [];
    const failures = [];

    for (const [tableName, columns] of Object.entries(REQUIRED_SCHEMA)) {
        const tableRows = await query(
            `SELECT TABLE_NAME
             FROM information_schema.TABLES
             WHERE TABLE_SCHEMA = ?
               AND TABLE_NAME = ?
             LIMIT 1`,
            [databaseName, tableName]
        );

        if (tableRows.length === 0) {
            report.push({ table: tableName, ok: false, missing: ['<table missing>'] });
            failures.push(`Missing table: ${tableName}`);
            continue;
        }

        const columnRows = await query(
            `SELECT COLUMN_NAME
             FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = ?
               AND TABLE_NAME = ?`,
            [databaseName, tableName]
        );
        const presentColumns = new Set(columnRows.map((row) => row.COLUMN_NAME));
        const missingColumns = columns.filter((column) => !presentColumns.has(column));

        report.push({
            table: tableName,
            ok: missingColumns.length === 0,
            missing: missingColumns,
        });

        missingColumns.forEach((column) => {
            failures.push(`Missing column: ${tableName}.${column}`);
        });
    }

    const liveQueueDueIndex = await query(
        `SELECT INDEX_NAME
         FROM information_schema.STATISTICS
         WHERE TABLE_SCHEMA = ?
           AND TABLE_NAME = 'tbl_live_queue_sessions'
           AND INDEX_NAME = 'idx_live_queue_sessions_auto_due'
         LIMIT 1`,
        [databaseName]
    );

    if (liveQueueDueIndex.length === 0) {
        failures.push('Missing index: tbl_live_queue_sessions.idx_live_queue_sessions_auto_due');
    }

    const liveEtaIndex = await query(
        `SELECT INDEX_NAME
         FROM information_schema.STATISTICS
         WHERE TABLE_SCHEMA = ?
           AND TABLE_NAME = 'tbl_appointments'
           AND INDEX_NAME = 'idx_tbl_appointments_live_eta'
         LIMIT 1`,
        [databaseName]
    );

    if (liveEtaIndex.length === 0) {
        failures.push('Missing index: tbl_appointments.idx_tbl_appointments_live_eta');
    }

    const dataChecks = await query(
        `SELECT
            (SELECT COUNT(*)
             FROM master_treatments
             WHERE treatment_code IS NOT NULL
               AND treatment_code <> '') AS treatment_codes,
            (SELECT COUNT(*)
             FROM master_token_extension_mix
             WHERE is_active = 1) AS active_extension_mix`
    );

    const dataCheck = dataChecks[0] || {};
    if (Number(dataCheck.treatment_codes) < 4) {
        failures.push('Treatment code seed incomplete: expected at least 4 coded treatments');
    }

    if (Number(dataCheck.active_extension_mix) < 3) {
        failures.push('Extra-token mix seed incomplete: expected 3 active mix rows');
    }

    return {
        ok: failures.length === 0,
        report,
        dataCheck,
        failures,
    };
};

const pickContext = async ({ branchId, slotId, appointmentDate }) => {
    if (branchId && slotId && appointmentDate) {
        return {
            branchId: Number(branchId),
            slotId: Number(slotId),
            appointmentDate,
            source: 'cli',
        };
    }

    const rows = await query(
        `SELECT
            DATE_FORMAT(a.appointment_date, '%Y-%m-%d') AS appointment_date,
            a.fk_branch_id AS branch_id,
            b.branch_name,
            a.fk_slot_id AS slot_id,
            s.slot_name,
            COUNT(*) AS total,
            SUM(
                a.is_active = 1
                AND LOWER(a.status) IN ('pending', 'confirmed')
                AND a.queue_status IN ('BOOKED', 'CHECKED_IN', 'WAITING', 'IN_PROGRESS')
            ) AS active_queue
         FROM tbl_appointments a
         JOIN master_clinic_branches b ON b.id = a.fk_branch_id
         JOIN master_slots s ON s.id = a.fk_slot_id
         WHERE a.appointment_date >= DATE_SUB(CURDATE(), INTERVAL 60 DAY)
         GROUP BY a.appointment_date, a.fk_branch_id, a.fk_slot_id
         HAVING total > 0
         ORDER BY a.appointment_date DESC, active_queue DESC, total DESC
         LIMIT 1`
    );

    if (rows.length === 0) {
        return null;
    }

    return {
        branchId: Number(rows[0].branch_id),
        slotId: Number(rows[0].slot_id),
        appointmentDate: rows[0].appointment_date,
        branchName: rows[0].branch_name,
        slotName: rows[0].slot_name,
        source: 'latest-db-context',
    };
};

const validateLiveSnapshot = (snapshot) => {
    const failures = [];
    const prefix = expectedTokenPrefix({
        slotName: snapshot.slot_name,
        startTime: snapshot.slot_start_time,
    });

    if (!snapshot.session || !snapshot.totals) {
        failures.push('Live queue snapshot missing session/totals');
    }

    [
        'active_queue',
        'ready_queue',
        'called_queue',
        'hold_queue',
        'not_arrived_queue',
        'waiting_queue',
    ].forEach((field) => {
        if (!Array.isArray(snapshot[field])) {
            failures.push(`Live queue snapshot ${field} is not an array`);
        }
    });

    if (
        snapshot.totals
        && Array.isArray(snapshot.active_queue)
        && Number(snapshot.totals.active) !== snapshot.active_queue.length
    ) {
        failures.push(`Totals mismatch: totals.active=${snapshot.totals.active}, active_queue.length=${snapshot.active_queue.length}`);
    }

    const tokenRows = [
        snapshot.current_running_token,
        ...(snapshot.ready_queue || []),
        ...(snapshot.called_queue || []),
        ...(snapshot.hold_queue || []),
    ].filter(Boolean);

    if (prefix) {
        tokenRows.forEach((item) => {
            if (!String(item.display_token_display || '').startsWith(`${prefix}-`)) {
                failures.push(`Token display missing ${prefix}- prefix for appointment ${item.appointment_id}`);
            }
        });
    }

    [
        ...(snapshot.ready_queue || []),
        ...(snapshot.called_queue || []),
        ...(snapshot.hold_queue || []),
        ...(snapshot.active_queue || []),
    ].forEach((item) => {
        if (!item.current_queue_start_at && !item.current_queue_end_at) {
            return;
        }

        if (item.live_estimated_start_at !== item.current_queue_start_at) {
            failures.push(`Stale ETA start for appointment ${item.appointment_id}: live=${item.live_estimated_start_at}, projected=${item.current_queue_start_at}`);
        }

        if (item.live_estimated_end_at !== item.current_queue_end_at) {
            failures.push(`Stale ETA end for appointment ${item.appointment_id}: live=${item.live_estimated_end_at}, projected=${item.current_queue_end_at}`);
        }
    });

    if (
        snapshot.next_ready_token
        && Array.isArray(snapshot.ready_queue)
        && snapshot.ready_queue.length > 0
        && Number(snapshot.next_ready_token.appointment_id) !== Number(snapshot.ready_queue[0].appointment_id)
    ) {
        failures.push('next_ready_token does not match ready_queue[0]');
    }

    return {
        ok: failures.length === 0,
        failures,
    };
};

const validateCurrentDateTokens = (currentDateTokens, snapshot) => {
    const failures = [];

    if (!currentDateTokens || !Array.isArray(currentDateTokens.tokens)) {
        failures.push('Current-date tokens response missing tokens array');
        return { ok: false, failures };
    }

    if (Number(currentDateTokens.total_tokens) !== currentDateTokens.tokens.length) {
        failures.push(`Current-date token total mismatch: total_tokens=${currentDateTokens.total_tokens}, tokens.length=${currentDateTokens.tokens.length}`);
    }

    if (Number(snapshot.totals?.active || 0) !== currentDateTokens.tokens.length) {
        failures.push(`Snapshot/current-date mismatch: snapshot active=${snapshot.totals?.active}, tokens.length=${currentDateTokens.tokens.length}`);
    }

    currentDateTokens.tokens
        .filter((item) => item.current_queue_start_at || item.current_queue_end_at)
        .forEach((item) => {
            if (item.live_estimated_start_at !== item.current_queue_start_at) {
                failures.push(`Current-date stale ETA start for appointment ${item.appointment_id}`);
            }

            if (item.live_estimated_end_at !== item.current_queue_end_at) {
                failures.push(`Current-date stale ETA end for appointment ${item.appointment_id}`);
            }
        });

    return {
        ok: failures.length === 0,
        failures,
    };
};

const main = async () => {
    const args = parseArgs();
    const context = await pickContext({
        branchId: args.branchId,
        slotId: args.slotId,
        appointmentDate: args.appointmentDate,
    });

    if (!context) {
        throw new Error('No appointment context found for Live Queue check');
    }

    const schema = await checkSchema();
    const snapshot = await getLiveQueueSnapshot({
        branchId: context.branchId,
        slotId: context.slotId,
        appointmentDate: context.appointmentDate,
    });
    const snapshotValidation = validateLiveSnapshot(snapshot);
    const currentDateTokens = await getCurrentDateTokenList({
        branchId: context.branchId,
        slotId: context.slotId,
        appointmentDate: context.appointmentDate,
    });
    const currentDateValidation = validateCurrentDateTokens(currentDateTokens, snapshot);

    const failures = [
        ...schema.failures,
        ...snapshotValidation.failures,
        ...currentDateValidation.failures,
    ];

    const result = {
        ok: failures.length === 0,
        context,
        schema: {
            ok: schema.ok,
            missing: schema.report
                .filter((item) => !item.ok)
                .map((item) => ({ table: item.table, missing: item.missing })),
            dataCheck: schema.dataCheck,
        },
        liveQueue: {
            ok: snapshotValidation.ok,
            session: snapshot.session,
            totals: snapshot.totals,
            current_running_token: compactToken(snapshot.current_running_token),
            next_ready_token: compactToken(snapshot.next_ready_token),
            ready_sample: (snapshot.ready_queue || []).slice(0, 5).map(compactToken),
            hold_sample: (snapshot.hold_queue || []).slice(0, 5).map(compactToken),
            not_arrived_count: (snapshot.not_arrived_queue || []).length,
        },
        currentDateTokens: {
            ok: currentDateValidation.ok,
            total_tokens: currentDateTokens.total_tokens,
            groups: (currentDateTokens.groups || []).map((group) => ({
                branch_id: group.branch_id,
                slot_id: group.slot_id,
                appointment_date: normalizeDateValue(group.appointment_date),
                tokens: group.tokens.length,
            })),
        },
        failures,
    };

    console.log(JSON.stringify(result, null, 2));

    if (!result.ok) {
        process.exitCode = 1;
    }
};

main()
    .catch((error) => {
        console.error(JSON.stringify({
            ok: false,
            error: error.message,
        }, null, 2));
        process.exitCode = 1;
    })
    .finally(async () => {
        await pool.end();
    });
