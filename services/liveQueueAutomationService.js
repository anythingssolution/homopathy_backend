const { query, withTransaction } = require('../config/db');
const AppError = require('../utils/AppError');
const {
    emitLiveQueueEvent,
    autoSelectAndCallNextReady,
    recalculateLiveRuntimeProjection,
    formatDateTimeForSql,
} = require('./liveQueueService');

const DEFAULT_AUTO_CALL_DELAY_MS = 3000;
const DEFAULT_RESUME_AUTO_CALL_DELAY_MS = 3000;
const AUTO_CALL_NEXT_WORKER_INTERVAL_MS = 1000;

const scheduledQueueTimers = new Map();
let liveQueueDueJobWorkerHandle = null;
let isDueJobWorkerRunning = false;

const buildAutomationKey = ({ branchId, slotId, appointmentDate }) => (
    `${branchId}:${slotId}:${appointmentDate}`
);

const clearInMemoryAutoCallNext = ({ branchId, slotId, appointmentDate }) => {
    const key = buildAutomationKey({ branchId, slotId, appointmentDate });
    const existingTimer = scheduledQueueTimers.get(key);

    if (existingTimer) {
        clearTimeout(existingTimer);
        scheduledQueueTimers.delete(key);
    }
};

const clearPersistedAutoCallNext = async ({
    branchId,
    slotId,
    appointmentDate,
}) => {
    await query(
        `UPDATE tbl_live_queue_sessions
         SET auto_call_next_due_at = NULL,
             auto_call_next_reason = NULL
         WHERE fk_branch_id = ?
           AND fk_slot_id = ?
           AND appointment_date = ?`,
        [branchId, slotId, appointmentDate]
    );
};

const cancelScheduledAutoCallNext = async ({
    branchId,
    slotId,
    appointmentDate,
}) => {
    if (!branchId || !slotId || !appointmentDate) {
        return;
    }

    clearInMemoryAutoCallNext({ branchId, slotId, appointmentDate });
    await clearPersistedAutoCallNext({ branchId, slotId, appointmentDate });
};

const processSingleDueAutoCallNext = async ({
    branchId,
    slotId,
    appointmentDate,
}) => {
    const result = await withTransaction(async (connection) => {
        const [rows] = await connection.execute(
            `SELECT id,
                    fk_branch_id,
                    fk_slot_id,
                    appointment_date,
                    session_status,
                    current_appointment_id,
                    auto_call_next_due_at,
                    auto_call_next_reason
             FROM tbl_live_queue_sessions
             WHERE fk_branch_id = ?
               AND fk_slot_id = ?
               AND appointment_date = ?
               AND auto_call_next_due_at IS NOT NULL
               AND auto_call_next_due_at <= NOW()
             LIMIT 1
             FOR UPDATE`,
            [branchId, slotId, appointmentDate]
        );

        if (rows.length === 0) {
            return null;
        }

        const session = rows[0];

        const clearSchedule = async () => {
            await connection.execute(
                `UPDATE tbl_live_queue_sessions
                 SET auto_call_next_due_at = NULL,
                     auto_call_next_reason = NULL
                 WHERE id = ?`,
                [session.id]
            );
        };

        if (session.session_status !== 'RUNNING') {
            await clearSchedule();
            await recalculateLiveRuntimeProjection(connection, {
                branchId,
                slotId,
                appointmentDate,
            });
            return null;
        }

        if (Number(session.current_appointment_id) > 0) {
            await clearSchedule();
            await recalculateLiveRuntimeProjection(connection, {
                branchId,
                slotId,
                appointmentDate,
            });
            return null;
        }

        try {
            const called = await autoSelectAndCallNextReady(connection, {
                branchId,
                slotId,
                appointmentDate,
                actorUserId: null,
                actorIp: null,
                eventType: 'TOKEN_CALLED_AUTO_NEXT',
                selectionBasis: 'DURABLE_AUTO_NEXT_DUE_AT',
                startImmediately: false,
            });

            await clearSchedule();

            return {
                ...called,
                reason: session.auto_call_next_reason || 'AUTO_CALL_NEXT_SCHEDULED',
            };
        } catch (error) {
            await clearSchedule();

            if (error instanceof AppError && [404, 409].includes(Number(error.statusCode))) {
                await recalculateLiveRuntimeProjection(connection, {
                    branchId,
                    slotId,
                    appointmentDate,
                });
                return null;
            }

            throw error;
        }
    });

    if (result) {
        await emitLiveQueueEvent({
            branchId: result.branchId,
            slotId: result.slotId,
            appointmentDate: result.appointmentDate,
            eventName: 'token-called',
            reason: result.reason,
            appointmentId: result.appointmentId,
            extra: {
                token_number: result.tokenNumber,
                auto_selected: true,
                durable_auto_next: true,
            },
        });
    }

    return result;
};

const processDueAutoCallNext = async ({
    limit = 10,
    scope = null,
} = {}) => {
    const params = [];
    const conditions = [
        'auto_call_next_due_at IS NOT NULL',
        'auto_call_next_due_at <= NOW()',
    ];

    if (scope?.branchId) {
        conditions.push('fk_branch_id = ?');
        params.push(scope.branchId);
    }

    if (scope?.slotId) {
        conditions.push('fk_slot_id = ?');
        params.push(scope.slotId);
    }

    if (scope?.appointmentDate) {
        conditions.push('appointment_date = ?');
        params.push(scope.appointmentDate);
    }

    const dueSessions = await query(
        `SELECT fk_branch_id, fk_slot_id, appointment_date
         FROM tbl_live_queue_sessions
         WHERE ${conditions.join(' AND ')}
         ORDER BY auto_call_next_due_at ASC
         LIMIT ?`,
        [...params, Number(limit) || 10]
    );

    let processedCount = 0;

    for (const session of dueSessions) {
        try {
            const processed = await processSingleDueAutoCallNext({
                branchId: Number(session.fk_branch_id),
                slotId: Number(session.fk_slot_id),
                appointmentDate: session.appointment_date,
            });

            if (processed) {
                processedCount += 1;
            }
        } catch (error) {
            console.error('Durable auto call-next processing failed:', error);
        }
    }

    return processedCount;
};

const scheduleAutoCallNext = async ({
    branchId,
    slotId,
    appointmentDate,
    actorUserId = null,
    delayMs = DEFAULT_AUTO_CALL_DELAY_MS,
    reason = 'AUTO_CALL_NEXT_SCHEDULED',
}) => {
    if (!branchId || !slotId || !appointmentDate) {
        return null;
    }

    await cancelScheduledAutoCallNext({ branchId, slotId, appointmentDate });

    const dueAt = new Date(Date.now() + Math.max(0, Number(delayMs) || DEFAULT_AUTO_CALL_DELAY_MS));

    await query(
        `UPDATE tbl_live_queue_sessions
         SET auto_call_next_due_at = ?,
             auto_call_next_reason = ?,
             updated_by = COALESCE(?, updated_by)
         WHERE fk_branch_id = ?
           AND fk_slot_id = ?
           AND appointment_date = ?`,
        [
            formatDateTimeForSql(dueAt),
            reason,
            actorUserId,
            branchId,
            slotId,
            appointmentDate,
        ]
    );

    const key = buildAutomationKey({ branchId, slotId, appointmentDate });
    const timer = setTimeout(async () => {
        scheduledQueueTimers.delete(key);
        await processDueAutoCallNext({
            limit: 1,
            scope: { branchId, slotId, appointmentDate },
        });
    }, Math.max(0, Number(delayMs) || DEFAULT_AUTO_CALL_DELAY_MS) + 50);

    scheduledQueueTimers.set(key, timer);

    return dueAt;
};

const startLiveQueueDueJobWorker = () => {
    if (liveQueueDueJobWorkerHandle) {
        return liveQueueDueJobWorkerHandle;
    }

    liveQueueDueJobWorkerHandle = setInterval(async () => {
        if (isDueJobWorkerRunning) {
            return;
        }

        isDueJobWorkerRunning = true;

        try {
            await processDueAutoCallNext({ limit: 20 });
        } catch (error) {
            console.error('Live queue due-job worker failed:', error);
        } finally {
            isDueJobWorkerRunning = false;
        }
    }, AUTO_CALL_NEXT_WORKER_INTERVAL_MS);

    return liveQueueDueJobWorkerHandle;
};

module.exports = {
    DEFAULT_AUTO_CALL_DELAY_MS,
    DEFAULT_RESUME_AUTO_CALL_DELAY_MS,
    AUTO_CALL_NEXT_WORKER_INTERVAL_MS,
    cancelScheduledAutoCallNext,
    scheduleAutoCallNext,
    processDueAutoCallNext,
    startLiveQueueDueJobWorker,
};
