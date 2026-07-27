const test = require('node:test');
const assert = require('node:assert/strict');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-live-queue';
process.env.DB_HOST = process.env.DB_HOST || '127.0.0.1';
process.env.DB_USER = process.env.DB_USER || 'test';
process.env.DB_NAME = process.env.DB_NAME || 'test';

const {
    applyFrozenDisplaySequenceToDerivedView,
    buildDerivedLiveQueueView,
    buildFrozenDisplaySequenceView,
    SESSION_STATUS,
    sortReadyCandidatesByFrozenQueueSequence,
    sortAppointmentsByRuntimeQueue,
} = require('../services/liveQueueService');

const makeQueueItem = ({
    appointmentId,
    tokenNumber,
    plannedStartAt,
    checkedInAt = null,
}) => ({
    appointment_id: appointmentId,
    original_token_number: tokenNumber,
    current_token_number: tokenNumber,
    queue_status: checkedInAt ? 'CHECKED_IN' : 'BOOKED',
    checked_in_at: checkedInAt,
    planned_start_at: plannedStartAt,
});

const makeBlankSlot = ({ tokenNumber, plannedStartAt }) => ({
    appointment_id: -tokenNumber,
    is_virtual_blank_slot: true,
    original_token_number: tokenNumber,
    current_token_number: tokenNumber,
    token_number: tokenNumber,
    queue_status: 'BOOKED',
    checked_in_at: null,
    planned_start_at: plannedStartAt,
});

test('session queue position includes already consulted patients without DB fields', () => {
    const queueContext = {
        fk_branch_id: 1,
        fk_slot_id: 1,
        appointment_date: '2026-07-02',
    };
    const currentToken = {
        ...makeQueueItem({
            appointmentId: 4,
            tokenNumber: 4,
            plannedStartAt: '2026-07-02 10:15:00',
            checkedInAt: '2026-07-02 10:10:00',
        }),
        ...queueContext,
        queue_status: 'IN_PROGRESS',
        actual_started_at: '2026-07-02 10:18:00',
    };
    const nextToken = {
        ...makeQueueItem({
            appointmentId: 5,
            tokenNumber: 5,
            plannedStartAt: '2026-07-02 10:30:00',
            checkedInAt: '2026-07-02 10:12:00',
        }),
        ...queueContext,
    };
    const completedToken = {
        ...makeQueueItem({
            appointmentId: 1,
            tokenNumber: 1,
            plannedStartAt: '2026-07-02 10:00:00',
            checkedInAt: '2026-07-02 09:55:00',
        }),
        ...queueContext,
        queue_status: 'COMPLETED',
        actual_completed_at: '2026-07-02 10:12:00',
    };

    const result = sortAppointmentsByRuntimeQueue([currentToken, nextToken], {
        sessions: [{
            ...queueContext,
            session_status: SESSION_STATUS.RUNNING,
            current_appointment_id: 4,
        }],
        timelineRows: [completedToken, currentToken, nextToken],
        now: new Date(2026, 6, 2, 10, 20, 0),
    });

    assert.equal(result[0].appointment_id, 4);
    assert.equal(result[0].live_queue_position, 1);
    assert.equal(result[0].completed_before, 1);
    assert.equal(result[0].session_queue_position, 2);
    assert.equal(result[1].session_queue_position, 3);
    assert.match(result[0].position_explanation, /1 patient is already consulted/);
});

test('call-next candidate order uses frozen live sequence instead of token renumbering', () => {
    const rows = sortReadyCandidatesByFrozenQueueSequence([
        {
            appointment_id: 9,
            current_token_number: 9,
            original_token_number: 9,
            queue_status: 'CHECKED_IN',
            checked_in_at: '2026-07-02 11:01:00',
            planned_start_at: '2026-07-02 11:05:00',
            live_estimated_start_at: '2026-07-02 12:30:00',
            created_at: '2026-07-02 10:01:00',
        },
        {
            appointment_id: 6,
            current_token_number: 6,
            original_token_number: 6,
            queue_status: 'CHECKED_IN',
            checked_in_at: '2026-07-02 11:03:00',
            planned_start_at: '2026-07-02 10:52:00',
            live_estimated_start_at: '2026-07-02 12:12:00',
            created_at: '2026-07-02 10:02:00',
        },
    ]);

    assert.equal(rows[0].appointment_id, 6);
    assert.deepEqual(rows.map((row) => row.appointment_id), [6, 9]);
});

test('frozen display sequence keeps hold tokens ahead after a later token becomes current', () => {
    const queueContext = {
        fk_branch_id: 1,
        fk_slot_id: 1,
        appointment_date: '2026-07-02',
    };
    const completedTokens = [1, 2, 4, 8].map((tokenNumber, index) => ({
        ...makeQueueItem({
            appointmentId: tokenNumber,
            tokenNumber,
            plannedStartAt: `2026-07-02 11:${String(index * 5).padStart(2, '0')}:00`,
            checkedInAt: `2026-07-02 11:${String(index * 5).padStart(2, '0')}:30`,
        }),
        ...queueContext,
        queue_status: 'COMPLETED',
        actual_called_at: `2026-07-02 17:1${index}:00`,
        actual_completed_at: `2026-07-02 17:1${index}:30`,
    }));
    const currentToken = {
        ...makeQueueItem({
            appointmentId: 12,
            tokenNumber: 12,
            plannedStartAt: '2026-07-02 11:59:00',
            checkedInAt: '2026-07-02 11:55:24',
        }),
        ...queueContext,
        queue_status: 'WAITING',
        actual_called_at: '2026-07-02 17:19:35',
    };
    const activeTokens = [
        currentToken,
        {
            ...makeQueueItem({
                appointmentId: 5,
                tokenNumber: 5,
                plannedStartAt: '2026-07-02 11:20:00',
            }),
            ...queueContext,
        },
        {
            ...makeQueueItem({
                appointmentId: 6,
                tokenNumber: 6,
                plannedStartAt: '2026-07-02 11:22:00',
                checkedInAt: '2026-07-02 12:25:13',
            }),
            ...queueContext,
        },
        {
            ...makeQueueItem({
                appointmentId: 3,
                tokenNumber: 3,
                plannedStartAt: '2026-07-02 11:10:00',
                checkedInAt: '2026-07-02 17:18:40',
            }),
            ...queueContext,
        },
        {
            ...makeQueueItem({
                appointmentId: 7,
                tokenNumber: 7,
                plannedStartAt: '2026-07-02 11:32:00',
            }),
            ...queueContext,
        },
        {
            ...makeQueueItem({
                appointmentId: 13,
                tokenNumber: 13,
                plannedStartAt: '2026-07-02 12:04:00',
                checkedInAt: '2026-07-02 12:09:26',
            }),
            ...queueContext,
        },
        {
            ...makeQueueItem({
                appointmentId: 14,
                tokenNumber: 14,
                plannedStartAt: '2026-07-02 12:09:00',
                checkedInAt: '2026-07-02 12:09:31',
            }),
            ...queueContext,
        },
        ...[9, 10, 11].map((tokenNumber) => ({
            ...makeQueueItem({
                appointmentId: tokenNumber,
                tokenNumber,
                plannedStartAt: `2026-07-02 11:${tokenNumber === 9 ? '42' : tokenNumber === 10 ? '47' : '49'}:00`,
            }),
            ...queueContext,
        })),
    ];
    const timelineItems = [...completedTokens, ...activeTokens];
    const rawView = buildDerivedLiveQueueView({
        queueItems: activeTokens,
        timelineItems,
        currentRunningAppointmentId: 12,
        sessionStatus: SESSION_STATUS.RUNNING,
        now: new Date(2026, 6, 2, 17, 20, 0),
        protectedWindowAppointmentIds: [1, 2, 4, 8, 12],
    });
    const frozenDisplaySequenceView = buildFrozenDisplaySequenceView({
        queueItems: activeTokens,
        timelineItems,
        sessionStatus: SESSION_STATUS.RUNNING,
        now: new Date(2026, 6, 2, 17, 20, 0),
        protectedWindowAppointmentIds: [1, 2, 4, 8, 12],
    });
    const fixedView = applyFrozenDisplaySequenceToDerivedView({
        derivedView: rawView,
        frozenDisplaySequenceView,
    });

    assert.deepEqual(
        fixedView.runtimeOrderedItems.slice(0, 5).map((item) => item.appointment_id),
        [12, 6, 3, 13, 14]
    );
    assert.equal(fixedView.nextRuntimeCandidate.appointment_id, 6);
    assert.equal(fixedView.nextRuntimeCandidate.is_on_hold, true);
});

test('completed rows stay visible but are excluded from active sequence rank', () => {
    const queueContext = {
        fk_branch_id: 1,
        fk_slot_id: 1,
        appointment_date: '2026-07-02',
    };
    const completedToken = {
        ...makeQueueItem({
            appointmentId: 1,
            tokenNumber: 1,
            plannedStartAt: '2026-07-02 10:00:00',
            checkedInAt: '2026-07-02 09:55:00',
        }),
        ...queueContext,
        queue_status: 'COMPLETED',
        actual_completed_at: '2026-07-02 10:12:00',
    };
    const currentToken = {
        ...makeQueueItem({
            appointmentId: 4,
            tokenNumber: 4,
            plannedStartAt: '2026-07-02 10:15:00',
            checkedInAt: '2026-07-02 10:10:00',
        }),
        ...queueContext,
        queue_status: 'IN_PROGRESS',
        actual_started_at: '2026-07-02 10:18:00',
    };

    const result = sortAppointmentsByRuntimeQueue([completedToken, currentToken], {
        sessions: [{
            ...queueContext,
            session_status: SESSION_STATUS.RUNNING,
            current_appointment_id: 4,
        }],
        timelineRows: [completedToken, currentToken],
        now: new Date(2026, 6, 2, 10, 20, 0),
    });
    const completedResult = result.find((item) => item.appointment_id === 1);
    const currentResult = result.find((item) => item.appointment_id === 4);

    assert.equal(completedResult.runtime_priority_rank, null);
    assert.equal(completedResult.active_queue_position, null);
    assert.equal(completedResult.session_queue_position, null);
    assert.equal(currentResult.active_queue_position, 1);
    assert.equal(currentResult.session_queue_position, 2);
});

test('present hold queue follows check-in order instead of lower token number', () => {
    const result = buildDerivedLiveQueueView({
        queueItems: [
            makeQueueItem({
                appointmentId: 1,
                tokenNumber: 1,
                plannedStartAt: '2026-06-15 08:00:00',
                checkedInAt: '2026-06-15 09:40:00',
            }),
            makeQueueItem({
                appointmentId: 2,
                tokenNumber: 2,
                plannedStartAt: '2026-06-15 08:10:00',
                checkedInAt: '2026-06-15 09:20:00',
            }),
            makeQueueItem({
                appointmentId: 3,
                tokenNumber: 3,
                plannedStartAt: '2026-06-15 09:00:00',
            }),
        ],
        sessionStatus: SESSION_STATUS.RUNNING,
        now: new Date(2026, 5, 15, 10, 0, 0),
    });

    assert.deepEqual(
        result.holdQueue.map((item) => item.appointment_id),
        [2, 1]
    );
    assert.equal(result.holdQueue[0].hold_waiting_minutes, 40);
    assert.equal(result.holdQueue[0].hold_priority_reason, 'CHECKED_IN_AFTER_GRACE_WINDOW');
    assert.equal(result.nextRuntimeCandidate.appointment_id, 2);
    assert.equal(result.nextRuntimeAssignmentMode, 'HOLD_REASSIGN');
});

test('scheduled token present on time keeps priority over waiting hold tokens', () => {
    const result = buildDerivedLiveQueueView({
        queueItems: [
            makeQueueItem({
                appointmentId: 1,
                tokenNumber: 1,
                plannedStartAt: '2026-06-15 08:00:00',
                checkedInAt: '2026-06-15 09:20:00',
            }),
            makeQueueItem({
                appointmentId: 2,
                tokenNumber: 2,
                plannedStartAt: '2026-06-15 10:00:00',
                checkedInAt: '2026-06-15 10:05:00',
            }),
        ],
        sessionStatus: SESSION_STATUS.RUNNING,
        now: new Date(2026, 5, 15, 10, 10, 0),
    });

    assert.equal(result.nextRuntimeCandidate.appointment_id, 2);
    assert.equal(result.nextRuntimeAssignmentMode, 'SCHEDULED_PRESENT');
});

test('present hold fills an absent blank slot before later scheduled token', () => {
    const result = buildDerivedLiveQueueView({
        queueItems: [
            makeQueueItem({
                appointmentId: 4,
                tokenNumber: 4,
                plannedStartAt: '2026-06-18 18:15:00',
                checkedInAt: '2026-06-18 18:32:11',
            }),
            makeQueueItem({
                appointmentId: 6,
                tokenNumber: 6,
                plannedStartAt: '2026-06-18 18:22:00',
            }),
            makeQueueItem({
                appointmentId: 7,
                tokenNumber: 7,
                plannedStartAt: '2026-06-18 18:32:00',
                checkedInAt: '2026-06-18 18:16:25',
            }),
        ],
        sessionStatus: SESSION_STATUS.RUNNING,
        now: new Date(2026, 5, 18, 19, 10, 0),
    });

    assert.equal(result.nextRuntimeCandidate.appointment_id, 4);
    assert.equal(result.nextRuntimeAssignmentMode, 'HOLD_REASSIGN');
    assert.deepEqual(
        result.readyQueue.map((item) => item.appointment_id),
        [4, 7]
    );
});

test('protected visible window keeps visible next token ahead of new late hold', () => {
    const result = buildDerivedLiveQueueView({
        queueItems: [
            makeQueueItem({
                appointmentId: 4,
                tokenNumber: 4,
                plannedStartAt: '2026-06-18 18:15:00',
                checkedInAt: '2026-06-18 18:32:11',
            }),
            makeQueueItem({
                appointmentId: 6,
                tokenNumber: 6,
                plannedStartAt: '2026-06-18 18:22:00',
            }),
            makeQueueItem({
                appointmentId: 7,
                tokenNumber: 7,
                plannedStartAt: '2026-06-18 18:32:00',
                checkedInAt: '2026-06-18 18:16:25',
            }),
        ],
        protectedWindowAppointmentIds: [7],
        sessionStatus: SESSION_STATUS.RUNNING,
        now: new Date(2026, 5, 18, 19, 10, 0),
    });

    assert.equal(result.nextRuntimeCandidate.appointment_id, 7);
    assert.equal(result.nextRuntimeAssignmentMode, 'SCHEDULED_PRESENT');
    assert.deepEqual(
        result.readyQueue.map((item) => item.appointment_id),
        [7, 4]
    );
});

test('protected visible window keeps already visible token ahead of new on-time check-in', () => {
    const result = buildDerivedLiveQueueView({
        queueItems: [
            makeQueueItem({
                appointmentId: 11,
                tokenNumber: 11,
                plannedStartAt: '2026-07-01 11:49:00',
                checkedInAt: '2026-07-01 11:23:09',
            }),
            makeQueueItem({
                appointmentId: 7,
                tokenNumber: 7,
                plannedStartAt: '2026-07-01 11:32:00',
                checkedInAt: '2026-07-01 11:34:33',
            }),
        ],
        protectedWindowAppointmentIds: [11],
        sessionStatus: SESSION_STATUS.RUNNING,
        now: new Date(2026, 6, 1, 11, 35, 0),
    });

    assert.equal(result.nextRuntimeCandidate.appointment_id, 11);
    assert.deepEqual(
        result.readyQueue.map((item) => item.appointment_id),
        [11, 7]
    );
});

test('protected visible window survives completed current token before next selection', () => {
    const result = buildDerivedLiveQueueView({
        queueItems: [
            makeQueueItem({
                appointmentId: 11,
                tokenNumber: 11,
                plannedStartAt: '2026-07-01 11:49:00',
                checkedInAt: '2026-07-01 11:23:09',
            }),
            makeQueueItem({
                appointmentId: 10,
                tokenNumber: 10,
                plannedStartAt: '2026-07-01 11:47:00',
                checkedInAt: '2026-07-01 11:53:41',
            }),
            makeQueueItem({
                appointmentId: 14,
                tokenNumber: 14,
                plannedStartAt: '2026-07-01 12:09:00',
                checkedInAt: '2026-07-01 11:53:47',
            }),
            makeQueueItem({
                appointmentId: 12,
                tokenNumber: 12,
                plannedStartAt: '2026-07-01 11:59:00',
                checkedInAt: '2026-07-01 11:53:58',
            }),
            makeQueueItem({
                appointmentId: 5,
                tokenNumber: 5,
                plannedStartAt: '2026-07-01 11:20:00',
                checkedInAt: '2026-07-01 11:54:06',
            }),
            makeQueueItem({
                appointmentId: 2,
                tokenNumber: 2,
                plannedStartAt: '2026-07-01 11:05:00',
                checkedInAt: '2026-07-01 11:54:37',
            }),
        ],
        protectedWindowAppointmentIds: [6, 11, 10, 14, 12],
        sessionStatus: SESSION_STATUS.RUNNING,
        now: new Date(2026, 6, 1, 11, 55, 7),
    });

    assert.equal(result.nextRuntimeCandidate.appointment_id, 11);
    assert.deepEqual(
        result.readyQueue.slice(0, 4).map((item) => item.appointment_id),
        [11, 10, 14, 12]
    );
});

test('present hold settles by check-in order into token gap between on-time anchors', () => {
    const queueItems = [
        {
            ...makeQueueItem({
                appointmentId: 7,
                tokenNumber: 7,
                plannedStartAt: '2026-06-27 12:25:00',
                checkedInAt: '2026-06-27 12:15:00',
            }),
            queue_status: 'IN_PROGRESS',
            actual_started_at: '2026-06-27 12:26:31',
        },
        makeQueueItem({
            appointmentId: 8,
            tokenNumber: 8,
            plannedStartAt: '2026-06-27 12:30:00',
            checkedInAt: '2026-06-27 12:20:00',
        }),
        makeQueueItem({
            appointmentId: 9,
            tokenNumber: 9,
            plannedStartAt: '2026-06-27 12:35:00',
            checkedInAt: '2026-06-27 12:30:00',
        }),
        makeQueueItem({
            appointmentId: 13,
            tokenNumber: 13,
            plannedStartAt: '2026-06-27 12:55:00',
            checkedInAt: '2026-06-27 13:12:04',
        }),
        makeQueueItem({
            appointmentId: 14,
            tokenNumber: 14,
            plannedStartAt: '2026-06-27 13:00:00',
            checkedInAt: '2026-06-27 13:16:10',
        }),
        makeQueueItem({
            appointmentId: 5,
            tokenNumber: 5,
            plannedStartAt: '2026-06-27 12:10:00',
            checkedInAt: '2026-06-27 13:22:00',
        }),
        makeQueueItem({
            appointmentId: 10,
            tokenNumber: 10,
            plannedStartAt: '2026-06-27 12:40:00',
            checkedInAt: '2026-06-27 13:25:00',
        }),
        makeQueueItem({
            appointmentId: 11,
            tokenNumber: 11,
            plannedStartAt: '2026-06-27 12:45:00',
            checkedInAt: '2026-06-27 13:26:00',
        }),
        makeQueueItem({
            appointmentId: 17,
            tokenNumber: 17,
            plannedStartAt: '2026-06-27 13:15:00',
            checkedInAt: '2026-06-27 13:10:00',
        }),
        makeQueueItem({
            appointmentId: 21,
            tokenNumber: 21,
            plannedStartAt: '2026-06-27 13:35:00',
            checkedInAt: '2026-06-27 13:30:00',
        }),
    ];
    const result = buildDerivedLiveQueueView({
        queueItems,
        timelineItems: [
            ...queueItems,
            makeBlankSlot({
                tokenNumber: 12,
                plannedStartAt: '2026-06-27 12:50:00',
            }),
            makeBlankSlot({
                tokenNumber: 15,
                plannedStartAt: '2026-06-27 13:05:00',
            }),
            makeBlankSlot({
                tokenNumber: 16,
                plannedStartAt: '2026-06-27 13:10:00',
            }),
        ],
        currentRunningAppointmentId: 7,
        sessionStatus: SESSION_STATUS.RUNNING,
        now: new Date(2026, 5, 27, 13, 40, 0),
    });

    assert.deepEqual(
        result.readyQueue.map((item) => item.appointment_id),
        [8, 9, 13, 14, 5, 10, 11, 17, 21]
    );
    assert.deepEqual(
        result.readyQueue
            .filter((item) => item.is_on_hold)
            .map((item) => item.runtime_settled_token_number),
        [10, 11, 12, 13, 14]
    );
});

test('present hold fills earliest gap slots after next scheduled token is already current', () => {
    const queueItems = [
        {
            ...makeQueueItem({
                appointmentId: 9,
                tokenNumber: 9,
                plannedStartAt: '2026-06-27 12:35:00',
                checkedInAt: '2026-06-27 12:30:00',
            }),
            queue_status: 'WAITING',
            actual_called_at: '2026-06-27 14:52:00',
        },
        makeQueueItem({
            appointmentId: 13,
            tokenNumber: 13,
            plannedStartAt: '2026-06-27 12:55:00',
            checkedInAt: '2026-06-27 13:12:04',
        }),
        makeQueueItem({
            appointmentId: 14,
            tokenNumber: 14,
            plannedStartAt: '2026-06-27 13:00:00',
            checkedInAt: '2026-06-27 13:16:10',
        }),
        makeQueueItem({
            appointmentId: 5,
            tokenNumber: 5,
            plannedStartAt: '2026-06-27 12:10:00',
            checkedInAt: '2026-06-27 13:22:00',
        }),
        makeQueueItem({
            appointmentId: 10,
            tokenNumber: 10,
            plannedStartAt: '2026-06-27 12:40:00',
            checkedInAt: '2026-06-27 14:18:00',
        }),
        makeQueueItem({
            appointmentId: 11,
            tokenNumber: 11,
            plannedStartAt: '2026-06-27 12:45:00',
            checkedInAt: '2026-06-27 14:37:36',
        }),
        makeQueueItem({
            appointmentId: 15,
            tokenNumber: 15,
            plannedStartAt: '2026-06-27 13:05:00',
            checkedInAt: '2026-06-27 14:47:26',
        }),
        makeQueueItem({
            appointmentId: 17,
            tokenNumber: 17,
            plannedStartAt: '2026-06-27 13:15:00',
            checkedInAt: '2026-06-27 13:10:00',
        }),
    ];
    const result = buildDerivedLiveQueueView({
        queueItems,
        timelineItems: [
            ...queueItems,
            makeBlankSlot({
                tokenNumber: 12,
                plannedStartAt: '2026-06-27 12:50:00',
            }),
            makeBlankSlot({
                tokenNumber: 16,
                plannedStartAt: '2026-06-27 13:10:00',
            }),
        ],
        currentRunningAppointmentId: 9,
        sessionStatus: SESSION_STATUS.RUNNING,
        now: new Date(2026, 5, 27, 14, 55, 0),
    });

    assert.deepEqual(
        result.readyQueue.map((item) => item.appointment_id),
        [13, 14, 5, 10, 11, 15, 17]
    );
    assert.deepEqual(
        result.readyQueue
            .filter((item) => item.is_on_hold)
            .map((item) => item.runtime_settled_token_number),
        [10, 11, 12, 13, 14, 15]
    );
});

test('current hold token consumes its settled slot before remaining hold queue is ordered', () => {
    const queueItems = [
        {
            ...makeQueueItem({
                appointmentId: 13,
                tokenNumber: 13,
                plannedStartAt: '2026-06-27 12:04:00',
                checkedInAt: '2026-06-27 12:24:04',
            }),
            queue_status: 'WAITING',
            actual_called_at: '2026-06-27 14:55:38',
        },
        makeQueueItem({
            appointmentId: 14,
            tokenNumber: 14,
            plannedStartAt: '2026-06-27 12:09:00',
            checkedInAt: '2026-06-27 12:24:10',
        }),
        makeQueueItem({
            appointmentId: 5,
            tokenNumber: 5,
            plannedStartAt: '2026-06-27 12:10:00',
            checkedInAt: '2026-06-27 12:28:03',
        }),
        makeQueueItem({
            appointmentId: 10,
            tokenNumber: 10,
            plannedStartAt: '2026-06-27 12:40:00',
            checkedInAt: '2026-06-27 14:18:00',
        }),
        makeQueueItem({
            appointmentId: 11,
            tokenNumber: 11,
            plannedStartAt: '2026-06-27 12:45:00',
            checkedInAt: '2026-06-27 14:37:36',
        }),
        makeQueueItem({
            appointmentId: 15,
            tokenNumber: 15,
            plannedStartAt: '2026-06-27 12:13:00',
            checkedInAt: '2026-06-27 14:47:26',
        }),
        makeQueueItem({
            appointmentId: 12,
            tokenNumber: 12,
            plannedStartAt: '2026-06-27 12:50:00',
            checkedInAt: '2026-06-27 14:55:10',
        }),
        makeQueueItem({
            appointmentId: 17,
            tokenNumber: 17,
            plannedStartAt: '2026-06-27 13:15:00',
            checkedInAt: '2026-06-27 13:10:00',
        }),
        makeQueueItem({
            appointmentId: 21,
            tokenNumber: 21,
            plannedStartAt: '2026-06-27 13:35:00',
            checkedInAt: '2026-06-27 13:30:00',
        }),
    ];
    const result = buildDerivedLiveQueueView({
        queueItems,
        timelineItems: [
            {
                ...makeQueueItem({
                    appointmentId: 9,
                    tokenNumber: 9,
                    plannedStartAt: '2026-06-27 12:35:00',
                    checkedInAt: '2026-06-27 12:30:00',
                }),
                queue_status: 'COMPLETED',
                actual_called_at: '2026-06-27 14:52:00',
                actual_completed_at: '2026-06-27 14:55:34',
            },
            ...queueItems,
            makeBlankSlot({
                tokenNumber: 16,
                plannedStartAt: '2026-06-27 13:10:00',
            }),
        ],
        currentRunningAppointmentId: 13,
        sessionStatus: SESSION_STATUS.RUNNING,
        now: new Date(2026, 5, 27, 14, 57, 0),
    });

    assert.deepEqual(
        result.readyQueue.map((item) => item.appointment_id),
        [14, 5, 10, 11, 15, 12, 17, 21]
    );
    assert.deepEqual(
        result.readyQueue
            .filter((item) => item.is_on_hold)
            .map((item) => item.runtime_settled_token_number),
        [11, 12, 13, 14, 15, 16]
    );
});

test('completed hold token keeps its consumed slot before selecting the next token', () => {
    const queueItems = [
        makeQueueItem({
            appointmentId: 14,
            tokenNumber: 14,
            plannedStartAt: '2026-06-27 12:09:00',
            checkedInAt: '2026-06-27 12:24:10',
        }),
        makeQueueItem({
            appointmentId: 5,
            tokenNumber: 5,
            plannedStartAt: '2026-06-27 12:10:00',
            checkedInAt: '2026-06-27 12:28:03',
        }),
        makeQueueItem({
            appointmentId: 10,
            tokenNumber: 10,
            plannedStartAt: '2026-06-27 12:40:00',
            checkedInAt: '2026-06-27 14:18:00',
        }),
        makeQueueItem({
            appointmentId: 11,
            tokenNumber: 11,
            plannedStartAt: '2026-06-27 12:45:00',
            checkedInAt: '2026-06-27 14:37:36',
        }),
        makeQueueItem({
            appointmentId: 15,
            tokenNumber: 15,
            plannedStartAt: '2026-06-27 12:13:00',
            checkedInAt: '2026-06-27 14:47:26',
        }),
        makeQueueItem({
            appointmentId: 12,
            tokenNumber: 12,
            plannedStartAt: '2026-06-27 12:50:00',
            checkedInAt: '2026-06-27 14:55:10',
        }),
        makeQueueItem({
            appointmentId: 17,
            tokenNumber: 17,
            plannedStartAt: '2026-06-27 13:15:00',
            checkedInAt: '2026-06-27 13:10:00',
        }),
        makeQueueItem({
            appointmentId: 21,
            tokenNumber: 21,
            plannedStartAt: '2026-06-27 13:35:00',
            checkedInAt: '2026-06-27 13:30:00',
        }),
    ];
    const result = buildDerivedLiveQueueView({
        queueItems,
        timelineItems: [
            {
                ...makeQueueItem({
                    appointmentId: 9,
                    tokenNumber: 9,
                    plannedStartAt: '2026-06-27 12:35:00',
                    checkedInAt: '2026-06-27 12:30:00',
                }),
                queue_status: 'COMPLETED',
                actual_called_at: '2026-06-27 14:52:00',
                actual_completed_at: '2026-06-27 14:55:34',
            },
            {
                ...makeQueueItem({
                    appointmentId: 13,
                    tokenNumber: 13,
                    plannedStartAt: '2026-06-27 12:04:00',
                    checkedInAt: '2026-06-27 12:24:04',
                }),
                queue_status: 'COMPLETED',
                actual_called_at: '2026-06-27 14:55:38',
                actual_completed_at: '2026-06-27 15:16:15',
            },
            ...queueItems,
            makeBlankSlot({
                tokenNumber: 16,
                plannedStartAt: '2026-06-27 13:10:00',
            }),
        ],
        sessionStatus: SESSION_STATUS.RUNNING,
        now: new Date(2026, 5, 27, 15, 16, 20),
    });

    assert.equal(result.nextRuntimeCandidate.appointment_id, 14);
    assert.deepEqual(
        result.readyQueue.map((item) => item.appointment_id),
        [14, 5, 10, 11, 15, 12, 17, 21]
    );
    assert.deepEqual(
        result.readyQueue
            .filter((item) => item.is_on_hold)
            .map((item) => item.runtime_settled_token_number),
        [11, 12, 13, 14, 15, 16]
    );
});

test('late higher token cannot settle before an earlier protected token', () => {
    const queueItems = [
        {
            ...makeQueueItem({
                appointmentId: 17,
                tokenNumber: 17,
                plannedStartAt: '2026-06-27 13:15:00',
                checkedInAt: '2026-06-27 13:10:00',
            }),
            queue_status: 'WAITING',
            actual_called_at: '2026-06-27 15:16:18',
        },
        makeQueueItem({
            appointmentId: 16,
            tokenNumber: 16,
            plannedStartAt: '2026-06-27 13:10:00',
            checkedInAt: '2026-06-27 15:27:42',
        }),
        makeQueueItem({
            appointmentId: 15,
            tokenNumber: 15,
            plannedStartAt: '2026-06-27 12:13:00',
            checkedInAt: '2026-06-27 15:27:59',
        }),
        makeQueueItem({
            appointmentId: 22,
            tokenNumber: 22,
            plannedStartAt: '2026-06-27 13:49:00',
            checkedInAt: '2026-06-27 15:29:15',
        }),
        makeQueueItem({
            appointmentId: 18,
            tokenNumber: 18,
            plannedStartAt: '2026-06-27 13:19:00',
            checkedInAt: '2026-06-27 15:29:18',
        }),
        makeQueueItem({
            appointmentId: 20,
            tokenNumber: 20,
            plannedStartAt: '2026-06-27 13:27:00',
            checkedInAt: '2026-06-27 15:29:23',
        }),
        makeQueueItem({
            appointmentId: 21,
            tokenNumber: 21,
            plannedStartAt: '2026-06-27 13:35:00',
            checkedInAt: '2026-06-27 13:30:00',
        }),
    ];
    const result = buildDerivedLiveQueueView({
        queueItems,
        timelineItems: [
            ...queueItems,
            makeBlankSlot({
                tokenNumber: 19,
                plannedStartAt: '2026-06-27 13:23:00',
            }),
            makeBlankSlot({
                tokenNumber: 23,
                plannedStartAt: '2026-06-27 13:53:00',
            }),
        ],
        currentRunningAppointmentId: 17,
        sessionStatus: SESSION_STATUS.RUNNING,
        now: new Date(2026, 5, 27, 15, 30, 0),
    });

    assert.deepEqual(
        result.readyQueue.map((item) => item.appointment_id),
        [16, 15, 21, 22, 18, 20]
    );
    assert.deepEqual(
        result.readyQueue
            .filter((item) => item.is_on_hold)
            .map((item) => item.runtime_settled_token_number),
        [18, 19, 22, 23, null]
    );
});

test('late original owner settles after existing blank-slot reassignment', () => {
    const result = buildDerivedLiveQueueView({
        queueItems: [
            makeQueueItem({
                appointmentId: 4,
                tokenNumber: 4,
                plannedStartAt: '2026-06-18 18:15:00',
                checkedInAt: '2026-06-18 18:32:11',
            }),
            makeQueueItem({
                appointmentId: 6,
                tokenNumber: 6,
                plannedStartAt: '2026-06-18 18:22:00',
                checkedInAt: '2026-06-18 19:31:00',
            }),
            makeQueueItem({
                appointmentId: 7,
                tokenNumber: 7,
                plannedStartAt: '2026-06-18 18:32:00',
                checkedInAt: '2026-06-18 18:16:25',
            }),
            makeQueueItem({
                appointmentId: 18,
                tokenNumber: 18,
                plannedStartAt: '2026-06-18 19:29:00',
                checkedInAt: '2026-06-18 19:27:28',
            }),
            makeQueueItem({
                appointmentId: 19,
                tokenNumber: 19,
                plannedStartAt: '2026-06-18 19:33:00',
            }),
        ],
        timelineItems: [
            makeQueueItem({
                appointmentId: 4,
                tokenNumber: 4,
                plannedStartAt: '2026-06-18 18:15:00',
                checkedInAt: '2026-06-18 18:32:11',
            }),
            makeQueueItem({
                appointmentId: 6,
                tokenNumber: 6,
                plannedStartAt: '2026-06-18 18:22:00',
                checkedInAt: '2026-06-18 19:31:00',
            }),
            makeQueueItem({
                appointmentId: 7,
                tokenNumber: 7,
                plannedStartAt: '2026-06-18 18:32:00',
                checkedInAt: '2026-06-18 18:16:25',
            }),
            makeBlankSlot({
                tokenNumber: 8,
                plannedStartAt: '2026-06-18 18:36:00',
            }),
            makeQueueItem({
                appointmentId: 18,
                tokenNumber: 18,
                plannedStartAt: '2026-06-18 19:29:00',
                checkedInAt: '2026-06-18 19:27:28',
            }),
            makeQueueItem({
                appointmentId: 19,
                tokenNumber: 19,
                plannedStartAt: '2026-06-18 19:33:00',
            }),
        ],
        sessionStatus: SESSION_STATUS.RUNNING,
        now: new Date(2026, 5, 18, 19, 32, 0),
    });

    assert.equal(result.nextRuntimeCandidate.appointment_id, 7);
    assert.equal(result.nextRuntimeAssignmentMode, 'SCHEDULED_PRESENT');
    assert.deepEqual(
        result.readyQueue.map((item) => item.appointment_id),
        [7, 4, 18, 6]
    );
});

test('settled late owner becomes next after left boundary token is completed', () => {
    const result = buildDerivedLiveQueueView({
        queueItems: [
            makeQueueItem({
                appointmentId: 6,
                tokenNumber: 6,
                plannedStartAt: '2026-06-18 18:22:00',
                checkedInAt: '2026-06-18 19:31:00',
            }),
            makeQueueItem({
                appointmentId: 18,
                tokenNumber: 18,
                plannedStartAt: '2026-06-18 19:29:00',
                checkedInAt: '2026-06-18 19:27:28',
            }),
            makeQueueItem({
                appointmentId: 19,
                tokenNumber: 19,
                plannedStartAt: '2026-06-18 19:33:00',
            }),
        ],
        timelineItems: [
            {
                ...makeQueueItem({
                    appointmentId: 7,
                    tokenNumber: 7,
                    plannedStartAt: '2026-06-18 18:32:00',
                    checkedInAt: '2026-06-18 18:16:25',
                }),
                queue_status: 'COMPLETED',
                actual_completed_at: '2026-06-18 19:40:00',
            },
            makeBlankSlot({
                tokenNumber: 8,
                plannedStartAt: '2026-06-18 18:36:00',
            }),
            makeQueueItem({
                appointmentId: 6,
                tokenNumber: 6,
                plannedStartAt: '2026-06-18 18:22:00',
                checkedInAt: '2026-06-18 19:31:00',
            }),
            makeQueueItem({
                appointmentId: 18,
                tokenNumber: 18,
                plannedStartAt: '2026-06-18 19:29:00',
                checkedInAt: '2026-06-18 19:27:28',
            }),
            makeQueueItem({
                appointmentId: 19,
                tokenNumber: 19,
                plannedStartAt: '2026-06-18 19:33:00',
            }),
        ],
        sessionStatus: SESSION_STATUS.RUNNING,
        now: new Date(2026, 5, 18, 19, 45, 0),
    });

    assert.equal(result.nextRuntimeCandidate.appointment_id, 6);
    assert.deepEqual(
        result.readyQueue.map((item) => item.appointment_id),
        [6, 18]
    );
});

test('late larger token cannot settle before smaller on-time ready token', () => {
    const result = buildDerivedLiveQueueView({
        queueItems: [
            makeQueueItem({
                appointmentId: 6,
                tokenNumber: 6,
                plannedStartAt: '2026-06-18 18:22:00',
                checkedInAt: '2026-06-18 19:31:00',
            }),
            makeQueueItem({
                appointmentId: 18,
                tokenNumber: 18,
                plannedStartAt: '2026-06-18 19:29:00',
                checkedInAt: '2026-06-18 19:27:28',
            }),
            makeQueueItem({
                appointmentId: 19,
                tokenNumber: 19,
                plannedStartAt: '2026-06-18 19:33:00',
                checkedInAt: '2026-06-18 20:01:23',
            }),
            makeBlankSlot({
                tokenNumber: 20,
                plannedStartAt: '2026-06-18 19:37:00',
            }),
            makeQueueItem({
                appointmentId: 23,
                tokenNumber: 23,
                plannedStartAt: '2026-06-18 19:53:00',
                checkedInAt: '2026-06-18 19:52:36',
            }),
        ],
        timelineItems: [
            makeQueueItem({
                appointmentId: 6,
                tokenNumber: 6,
                plannedStartAt: '2026-06-18 18:22:00',
                checkedInAt: '2026-06-18 19:31:00',
            }),
            makeQueueItem({
                appointmentId: 18,
                tokenNumber: 18,
                plannedStartAt: '2026-06-18 19:29:00',
                checkedInAt: '2026-06-18 19:27:28',
            }),
            makeQueueItem({
                appointmentId: 19,
                tokenNumber: 19,
                plannedStartAt: '2026-06-18 19:33:00',
                checkedInAt: '2026-06-18 20:01:23',
            }),
            makeBlankSlot({
                tokenNumber: 20,
                plannedStartAt: '2026-06-18 19:37:00',
            }),
            makeQueueItem({
                appointmentId: 23,
                tokenNumber: 23,
                plannedStartAt: '2026-06-18 19:53:00',
                checkedInAt: '2026-06-18 19:52:36',
            }),
        ],
        sessionStatus: SESSION_STATUS.RUNNING,
        now: new Date(2026, 5, 18, 20, 5, 0),
    });

    assert.deepEqual(
        result.readyQueue.map((item) => item.appointment_id),
        [18, 6, 23, 19]
    );
});

test('earlier on-time ready token stays before later scheduled token after hold completes', () => {
    const result = buildDerivedLiveQueueView({
        queueItems: [
            makeQueueItem({
                appointmentId: 18,
                tokenNumber: 18,
                plannedStartAt: '2026-06-18 19:29:00',
                checkedInAt: '2026-06-18 19:27:28',
            }),
            makeQueueItem({
                appointmentId: 19,
                tokenNumber: 19,
                plannedStartAt: '2026-06-18 19:33:00',
                checkedInAt: '2026-06-18 20:01:23',
            }),
            makeBlankSlot({
                tokenNumber: 20,
                plannedStartAt: '2026-06-18 19:37:00',
            }),
            makeQueueItem({
                appointmentId: 23,
                tokenNumber: 23,
                plannedStartAt: '2026-06-18 19:53:00',
                checkedInAt: '2026-06-18 19:52:36',
            }),
        ],
        timelineItems: [
            {
                ...makeQueueItem({
                    appointmentId: 6,
                    tokenNumber: 6,
                    plannedStartAt: '2026-06-18 18:22:00',
                    checkedInAt: '2026-06-18 19:31:00',
                }),
                queue_status: 'COMPLETED',
                actual_completed_at: '2026-06-18 20:05:00',
            },
            makeQueueItem({
                appointmentId: 18,
                tokenNumber: 18,
                plannedStartAt: '2026-06-18 19:29:00',
                checkedInAt: '2026-06-18 19:27:28',
            }),
            makeQueueItem({
                appointmentId: 19,
                tokenNumber: 19,
                plannedStartAt: '2026-06-18 19:33:00',
                checkedInAt: '2026-06-18 20:01:23',
            }),
            makeQueueItem({
                appointmentId: 23,
                tokenNumber: 23,
                plannedStartAt: '2026-06-18 19:53:00',
                checkedInAt: '2026-06-18 19:52:36',
            }),
        ],
        sessionStatus: SESSION_STATUS.RUNNING,
        now: new Date(2026, 5, 18, 20, 10, 0),
    });

    assert.equal(result.nextRuntimeCandidate.appointment_id, 18);
    assert.deepEqual(
        result.readyQueue.map((item) => item.appointment_id),
        [18, 19, 23]
    );
});

test('protected early check-in token keeps its planned slot over present hold', () => {
    const result = buildDerivedLiveQueueView({
        queueItems: [
            makeQueueItem({
                appointmentId: 1,
                tokenNumber: 2,
                plannedStartAt: '2026-06-16 10:05:00',
                checkedInAt: '2026-06-16 10:36:26',
            }),
            makeQueueItem({
                appointmentId: 2,
                tokenNumber: 9,
                plannedStartAt: '2026-06-16 10:42:00',
                checkedInAt: '2026-06-16 10:37:47',
            }),
        ],
        sessionStatus: SESSION_STATUS.RUNNING,
        now: new Date(2026, 5, 16, 10, 38, 46),
    });

    assert.equal(result.nextRuntimeCandidate.appointment_id, 2);
    assert.equal(result.nextRuntimeAssignmentMode, 'SCHEDULED_PRESENT');
});

test('check-in ordered hold next candidate is also first in ready queue with live position', () => {
    const result = buildDerivedLiveQueueView({
        queueItems: [
            makeQueueItem({
                appointmentId: 1,
                tokenNumber: 1,
                plannedStartAt: '2026-06-15 08:00:00',
                checkedInAt: '2026-06-15 09:40:00',
            }),
            makeQueueItem({
                appointmentId: 2,
                tokenNumber: 2,
                plannedStartAt: '2026-06-15 08:10:00',
                checkedInAt: '2026-06-15 09:20:00',
            }),
        ],
        sessionStatus: SESSION_STATUS.RUNNING,
        now: new Date(2026, 5, 15, 10, 0, 0),
    });

    assert.equal(result.nextRuntimeCandidate.appointment_id, 2);
    assert.equal(result.readyQueue[0].appointment_id, 2);
    assert.equal(result.readyQueue[0].live_queue_position, 1);
});

test('doctor runtime sort can use session current appointment context', () => {
    const rows = [
        makeQueueItem({
            appointmentId: 1,
            tokenNumber: 1,
            plannedStartAt: '2026-06-15 08:00:00',
            checkedInAt: '2026-06-15 09:20:00',
        }),
        {
            ...makeQueueItem({
                appointmentId: 2,
                tokenNumber: 2,
                plannedStartAt: '2026-06-15 08:10:00',
                checkedInAt: '2026-06-15 08:00:00',
            }),
            actual_started_at: '2026-06-15 09:00:00',
        },
    ].map((item) => ({
        ...item,
        fk_branch_id: 1,
        fk_slot_id: 1,
        appointment_date: '2026-06-15',
    }));

    const result = sortAppointmentsByRuntimeQueue(rows, {
        sessions: [{
            fk_branch_id: 1,
            fk_slot_id: 1,
            appointment_date: '2026-06-15',
            session_status: SESSION_STATUS.RUNNING,
            current_appointment_id: 2,
        }],
        now: new Date(2026, 5, 15, 10, 0, 0),
    });

    assert.equal(result[0].appointment_id, 2);
    assert.equal(result[0].checked_in_time_display, '08:00:00');
});

test('doctor runtime sort honors protected visible window for same queue sequence as live queue', () => {
    const rows = [
        {
            ...makeQueueItem({
                appointmentId: 1707,
                tokenNumber: 2,
                plannedStartAt: '2026-07-01 11:05:00',
                checkedInAt: '2026-07-01 12:00:35',
            }),
            queue_status: 'WAITING',
            actual_called_at: '2026-07-01 12:30:37',
        },
        makeQueueItem({
            appointmentId: 1719,
            tokenNumber: 13,
            plannedStartAt: '2026-07-01 12:04:00',
            checkedInAt: '2026-07-01 12:29:13',
        }),
        makeQueueItem({
            appointmentId: 1722,
            tokenNumber: 17,
            plannedStartAt: '2026-07-01 12:25:00',
            checkedInAt: '2026-07-01 12:21:13',
        }),
        makeQueueItem({
            appointmentId: 1723,
            tokenNumber: 18,
            plannedStartAt: '2026-07-01 12:29:00',
            checkedInAt: '2026-07-01 12:29:27',
        }),
        makeQueueItem({
            appointmentId: 1724,
            tokenNumber: 19,
            plannedStartAt: '2026-07-01 12:33:00',
            checkedInAt: '2026-07-01 12:39:51',
        }),
    ].map((item) => ({
        ...item,
        fk_branch_id: 1,
        fk_slot_id: 1,
        appointment_date: '2026-07-01',
    }));

    const result = sortAppointmentsByRuntimeQueue(rows, {
        sessions: [{
            fk_branch_id: 1,
            fk_slot_id: 1,
            appointment_date: '2026-07-01',
            session_status: SESSION_STATUS.RUNNING,
            current_appointment_id: 1707,
        }],
        timelineRows: rows,
        protectedWindowAppointmentIdsByGroup: new Map([
            ['2026-07-01:1:1', [1707, 1722, 1719, 1723]],
        ]),
        now: new Date(2026, 6, 1, 12, 45, 0),
    });

    assert.deepEqual(
        result.slice(0, 5).map((item) => item.appointment_id),
        [1707, 1722, 1719, 1723, 1724]
    );
});
