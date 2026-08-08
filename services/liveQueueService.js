const { query } = require('../config/db');
const AppError = require('../utils/AppError');
const { emitToLiveQueueRoom, emitToPublicLiveQueueRoom } = require('../utils/realtime');
const { decorateTokenFields, formatTokenDisplay, resolveTokenPrefix } = require('../utils/tokenDisplay');
const { getAppointmentPatientColumns, getAppointmentPatientJoin } = require('../utils/patientFamily');
const { getVisitTypeCode } = require('./followupService');
const { getPlateTokenByNumber, supportsTokenPlateVisitType } = require('../utils/appointmentTokens');
const { buildEffectiveSlotTokenPlate } = require('./slotTokenExtensionService');
const { resolveEffectiveSlotTiming } = require('./slotTimeOverrideService');

const QUEUE_STATUS = {
    BOOKED: 'BOOKED',
    CHECKED_IN: 'CHECKED_IN',
    WAITING: 'WAITING',
    IN_PROGRESS: 'IN_PROGRESS',
    COMPLETED: 'COMPLETED',
    CANCELLED: 'CANCELLED',
    NO_SHOW: 'NO_SHOW',
    SKIPPED: 'SKIPPED',
};

const ACTIVE_QUEUE_STATUSES = [
    QUEUE_STATUS.BOOKED,
    QUEUE_STATUS.CHECKED_IN,
    QUEUE_STATUS.WAITING,
    QUEUE_STATUS.IN_PROGRESS,
];

const READY_QUEUE_STATUSES = [
    QUEUE_STATUS.CHECKED_IN,
    QUEUE_STATUS.WAITING,
];

const PRESENT_QUEUE_STATUSES = [
    QUEUE_STATUS.CHECKED_IN,
    QUEUE_STATUS.WAITING,
    QUEUE_STATUS.IN_PROGRESS,
];

const SESSION_STATUS = {
    NOT_STARTED: 'NOT_STARTED',
    RUNNING: 'RUNNING',
    COMPLETED: 'COMPLETED',
    PAUSED: 'PAUSED',
};

const MYSQL_DATETIME_REGEX = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const TIME_REGEX = /^\d{2}:\d{2}(?::\d{2})?$/;
const CHECK_IN_GRACE_MINUTES = 15;
const PROTECTED_VISIBLE_QUEUE_WINDOW_SIZE = 5;
const PROTECTED_WINDOW_RESET_EVENT_TYPES = [
    'TOKEN_SKIPPED',
    'TOKEN_REASSIGNED',
];

const pad = (value) => String(value).padStart(2, '0');

const isValidDateString = (value) => DATE_REGEX.test(String(value || '').trim());

const parseMysqlDateTime = (value) => {
    if (!value) {
        return null;
    }

    if (value instanceof Date) {
        return Number.isNaN(value.getTime()) ? null : new Date(value.getTime());
    }

    const normalized = String(value).trim().replace('T', ' ').slice(0, 19);
    if (!MYSQL_DATETIME_REGEX.test(normalized)) {
        return null;
    }

    const [datePart, timePart] = normalized.split(' ');
    const [year, month, day] = datePart.split('-').map(Number);
    const [hour, minute, second] = timePart.split(':').map(Number);

    return new Date(year, month - 1, day, hour, minute, second);
};

const formatDateTimeForSql = (date) => {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
        return null;
    }

    return [
        date.getFullYear(),
        '-',
        pad(date.getMonth() + 1),
        '-',
        pad(date.getDate()),
        ' ',
        pad(date.getHours()),
        ':',
        pad(date.getMinutes()),
        ':',
        pad(date.getSeconds()),
    ].join('');
};

const addMinutes = (date, minutes) => {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
        return null;
    }

    return new Date(date.getTime() + (Number(minutes) || 0) * 60 * 1000);
};

const diffMinutes = (dateA, dateB) => {
    if (!(dateA instanceof Date) || Number.isNaN(dateA.getTime()) || !(dateB instanceof Date) || Number.isNaN(dateB.getTime())) {
        return 0;
    }

    return Math.round((dateA.getTime() - dateB.getTime()) / (60 * 1000));
};

const combineDateAndTime = (dateString, timeString) => {
    if (!isValidDateString(dateString) || !TIME_REGEX.test(String(timeString || '').trim())) {
        return null;
    }

    const [year, month, day] = String(dateString).split('-').map(Number);
    const [hour, minute, second = 0] = String(timeString).split(':').map(Number);

    return new Date(year, month - 1, day, hour, minute, second);
};

const formatDateToSqlDate = (date = new Date()) => [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
].join('-');

const normalizeAppointmentDateKey = (value) => {
    if (!value) {
        return '';
    }

    if (value instanceof Date) {
        return formatDateToSqlDate(value);
    }

    return String(value).split(/[ T]/)[0];
};

const parseTimeToMinutes = (timeValue) => {
    const normalized = String(timeValue || '').trim();

    if (!TIME_REGEX.test(normalized)) {
        return null;
    }

    const [hour, minute] = normalized.split(':').map(Number);
    return (hour * 60) + minute;
};

const resolveSlotBlockCode = ({
    slotName = null,
    startTime = null,
} = {}) => {
    const tokenPrefix = resolveTokenPrefix({
        slotName,
        startTime,
    });

    if (tokenPrefix === 'M' || tokenPrefix === 'E') {
        return tokenPrefix;
    }

    return null;
};

const toPositiveInt = (value) => {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) {
        return null;
    }

    return parsed;
};

const getExecutor = (connection = null) => async (sql, params = []) => {
    if (connection) {
        const [rows] = await connection.execute(sql, params);
        return rows;
    }

    return query(sql, params);
};

const listBranchSlotBlockContexts = async ({
    connection = null,
    branchId,
    appointmentDate = null,
    slotId = null,
    referenceDateTime = null,
    blockCode = null,
}) => {
    const execute = getExecutor(connection);
    const normalizedBranchId = toPositiveInt(branchId);
    const normalizedSlotId = slotId ? toPositiveInt(slotId) : null;

    if (!normalizedBranchId) {
        throw new AppError('Valid branch_id is required', 400);
    }

    if (slotId !== null && slotId !== undefined && !normalizedSlotId) {
        throw new AppError('Valid slot_id is required', 400);
    }

    const resolvedDate = isValidDateString(appointmentDate)
        ? String(appointmentDate).trim()
        : formatDateToSqlDate(referenceDateTime instanceof Date ? referenceDateTime : new Date());

    const rows = await execute(
        `SELECT
            s.id AS slot_id,
            s.fk_branch_id,
            s.slot_name,
            s.start_time,
            s.end_time,
            COALESCE(s.default_consult_minutes, 15) AS default_consult_minutes,
            b.branch_name
         FROM master_slots s
         JOIN master_clinic_branches b ON b.id = s.fk_branch_id
         WHERE s.fk_branch_id = ?
           AND s.is_active = 1
         ORDER BY s.start_time ASC, s.id ASC`,
        [normalizedBranchId]
    );

    const contexts = rows.map((row) => ({
        branchId: Number(row.fk_branch_id),
        branchName: row.branch_name,
        slotId: Number(row.slot_id),
        slotName: row.slot_name,
        slotStartTime: row.start_time,
        slotEndTime: row.end_time,
        defaultConsultMinutes: Number(row.default_consult_minutes) || 15,
        appointmentDate: resolvedDate,
        blockCode: resolveSlotBlockCode({
            slotName: row.slot_name,
            startTime: row.start_time,
        }),
    }));

    const targetSlotContext = normalizedSlotId
        ? contexts.find((item) => Number(item.slotId) === normalizedSlotId) || null
        : null;

    let resolvedBlockCode = blockCode || targetSlotContext?.blockCode || null;

    if (!resolvedBlockCode && referenceDateTime instanceof Date && !Number.isNaN(referenceDateTime.getTime())) {
        const referenceMinutes = (referenceDateTime.getHours() * 60) + referenceDateTime.getMinutes();
        const matchingContext = contexts.find((context) => {
            const startMinutes = parseTimeToMinutes(context.slotStartTime);
            const endMinutes = parseTimeToMinutes(context.slotEndTime);

            if (startMinutes === null || endMinutes === null) {
                return false;
            }

            return referenceMinutes >= startMinutes && referenceMinutes <= endMinutes;
        });

        const fallbackContext = matchingContext
            || contexts.find((context) => {
                const startMinutes = parseTimeToMinutes(context.slotStartTime);
                return startMinutes !== null && referenceMinutes <= startMinutes;
            })
            || contexts[contexts.length - 1]
            || null;

        resolvedBlockCode = fallbackContext?.blockCode || null;
    }

    const filteredContexts = resolvedBlockCode
        ? contexts.filter((context) => context.blockCode === resolvedBlockCode)
        : (targetSlotContext ? [targetSlotContext] : contexts);

    return {
        appointmentDate: resolvedDate,
        blockCode: resolvedBlockCode,
        targetSlotContext,
        slots: filteredContexts,
    };
};

const normalizeSequenceNumber = (value) => {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : Number.MAX_SAFE_INTEGER;
};

const normalizeDateOrderValue = (value) => {
    const parsed = parseMysqlDateTime(value);
    return parsed instanceof Date && !Number.isNaN(parsed.getTime()) ? parsed.getTime() : Number.MAX_SAFE_INTEGER;
};

const compareTokenNumbers = (left, right) => {
    const leftCurrentToken = normalizeSequenceNumber(left.current_token_number ?? left.token_number);
    const rightCurrentToken = normalizeSequenceNumber(right.current_token_number ?? right.token_number);

    if (leftCurrentToken !== rightCurrentToken) {
        return leftCurrentToken - rightCurrentToken;
    }

    const leftOriginalToken = normalizeSequenceNumber(left.original_token_number);
    const rightOriginalToken = normalizeSequenceNumber(right.original_token_number);

    if (leftOriginalToken !== rightOriginalToken) {
        return leftOriginalToken - rightOriginalToken;
    }

    return normalizeSequenceNumber(left.appointment_id) - normalizeSequenceNumber(right.appointment_id);
};

const comparePersistedLiveQueueAssignments = (left, right) => {
    const leftPosition = normalizeSequenceNumber(left?.live_queue_assigned_position);
    const rightPosition = normalizeSequenceNumber(right?.live_queue_assigned_position);

    if (
        leftPosition !== Number.MAX_SAFE_INTEGER
        && rightPosition !== Number.MAX_SAFE_INTEGER
        && leftPosition !== rightPosition
    ) {
        return leftPosition - rightPosition;
    }

    return 0;
};

const resolveEffectiveRuntimeEtaValue = (item) => normalizeDateOrderValue(
    item?.live_estimated_start_at
    || item?.estimated_start_at
    || item?.planned_start_at
    || null
);

const hasReservedSlotProtection = (item) => {
    if (!item?.checked_in_at) {
        return false;
    }

    const checkInAt = normalizeDateOrderValue(item.checked_in_at);
    const plannedStartAt = normalizeDateOrderValue(item.planned_start_at);

    if (checkInAt === Number.MAX_SAFE_INTEGER || plannedStartAt === Number.MAX_SAFE_INTEGER) {
        return false;
    }

    const bufferLimit = plannedStartAt + CHECK_IN_GRACE_MINUTES * 60 * 1000;
    return checkInAt <= bufferLimit;
};

const buildRuntimePriorityMeta = (item) => {
    const effectiveEtaSource = item?.live_estimated_start_at
        ? 'LIVE_ESTIMATED_START_AT'
        : (item?.estimated_start_at ? 'ESTIMATED_START_AT' : (item?.planned_start_at ? 'PLANNED_START_AT' : null));
    const slotProtected = hasReservedSlotProtection(item);

    return {
        effective_runtime_eta: item?.live_estimated_start_at || item?.estimated_start_at || item?.planned_start_at || null,
        effective_runtime_eta_display_basis: effectiveEtaSource,
        slot_protected: slotProtected,
        slot_protection_reason: slotProtected ? 'CHECKED_IN_ON_OR_BEFORE_EFFECTIVE_RUNTIME_ETA' : null,
        runtime_order_reason: slotProtected ? 'RESERVED_SLOT_PROTECTION' : 'TOKEN_BASED_FALLBACK',
    };
};

const compareRuntimeTimelineItems = (left, right) => {
    const assignedPositionOrder = comparePersistedLiveQueueAssignments(left, right);
    if (assignedPositionOrder !== 0) {
        return assignedPositionOrder;
    }

    const leftEta = resolveEffectiveRuntimeEtaValue(left);
    const rightEta = resolveEffectiveRuntimeEtaValue(right);

    if (leftEta !== rightEta) {
        return leftEta - rightEta;
    }

    return compareTokenNumbers(left, right);
};

const resolveFrozenReadySequenceOrderValue = (item) => normalizeDateOrderValue(
    item?.live_estimated_start_at
    || item?.planned_start_at
    || item?.checked_in_at
    || null
);

const compareFrozenReadySequenceItems = (left, right) => {
    const assignedPositionOrder = comparePersistedLiveQueueAssignments(left, right);
    if (assignedPositionOrder !== 0) {
        return assignedPositionOrder;
    }

    const leftOrder = resolveFrozenReadySequenceOrderValue(left);
    const rightOrder = resolveFrozenReadySequenceOrderValue(right);

    if (leftOrder !== rightOrder) {
        return leftOrder - rightOrder;
    }

    const tokenOrder = compareTokenNumbers(left, right);
    if (tokenOrder !== 0) {
        return tokenOrder;
    }

    const leftCreatedAt = normalizeDateOrderValue(left.created_at);
    const rightCreatedAt = normalizeDateOrderValue(right.created_at);
    if (leftCreatedAt !== rightCreatedAt) {
        return leftCreatedAt - rightCreatedAt;
    }

    return normalizeSequenceNumber(left.appointment_id) - normalizeSequenceNumber(right.appointment_id);
};

const sortReadyCandidatesByFrozenQueueSequence = (items = []) => (
    [...items].sort(compareFrozenReadySequenceItems)
);

const isQueueItemPresentNow = (item) => Boolean(item?.checked_in_at);

const isVirtualBlankSlot = (item) => Boolean(item?.is_virtual_blank_slot);

const getHoldWaitingMinutes = (item, now) => {
    const checkedInAt = parseMysqlDateTime(item?.checked_in_at);

    if (
        !(checkedInAt instanceof Date)
        || Number.isNaN(checkedInAt.getTime())
        || !(now instanceof Date)
        || Number.isNaN(now.getTime())
    ) {
        return null;
    }

    return Math.max(0, Math.floor((now.getTime() - checkedInAt.getTime()) / (60 * 1000)));
};

const compareHoldQueueItems = (left, right) => {
    const leftCheckedInAt = normalizeDateOrderValue(left.checked_in_at);
    const rightCheckedInAt = normalizeDateOrderValue(right.checked_in_at);

    if (leftCheckedInAt !== rightCheckedInAt) {
        return leftCheckedInAt - rightCheckedInAt;
    }

    const tokenOrder = compareTokenNumbers(left, right);
    if (tokenOrder !== 0) {
        return tokenOrder;
    }

    return normalizeSequenceNumber(left.appointment_id) - normalizeSequenceNumber(right.appointment_id);
};

const normalizeProtectedWindowAppointmentIds = (appointmentIds = []) => {
    const seenAppointmentIds = new Set();
    const protectedAppointmentIds = [];

    for (const appointmentIdValue of appointmentIds || []) {
        const appointmentId = Number(appointmentIdValue);

        if (!Number.isInteger(appointmentId) || appointmentId <= 0 || seenAppointmentIds.has(appointmentId)) {
            continue;
        }

        seenAppointmentIds.add(appointmentId);
        protectedAppointmentIds.push(appointmentId);

        if (protectedAppointmentIds.length >= PROTECTED_VISIBLE_QUEUE_WINDOW_SIZE) {
            break;
        }
    }

    return protectedAppointmentIds;
};

const parseProtectedWindowAppointmentIds = (metaJson = null) => {
    if (!metaJson) {
        return [];
    }

    try {
        const meta = typeof metaJson === 'string' ? JSON.parse(metaJson) : metaJson;
        return normalizeProtectedWindowAppointmentIds(meta?.protected_visible_window_appointment_ids || []);
    } catch (error) {
        return [];
    }
};

const MAX_POST_PROTECTED_SHUFFLES = 2;

const resolveBoundedEarlyArrivalAssignments = ({
    queueRows = [],
    checkingInAppointmentId,
    checkedInAt = new Date(),
}) => {
    const appointmentId = Number(checkingInAppointmentId || 0);
    const current = queueRows.find((row) => Number(row?.appointment_id || 0) === appointmentId) || null;
    const checkInDate = checkedInAt instanceof Date ? checkedInAt : parseMysqlDateTime(checkedInAt);
    const plannedStartAt = parseMysqlDateTime(current?.planned_start_at || null);

    if (!current || !(checkInDate instanceof Date) || Number.isNaN(checkInDate.getTime())) {
        return { applied: false, assignments: [], displacedAssignments: [] };
    }

    const checkInLimit = plannedStartAt instanceof Date && !Number.isNaN(plannedStartAt.getTime())
        ? addMinutes(plannedStartAt, CHECK_IN_GRACE_MINUTES)
        : null;
    if (!checkInLimit || checkInDate.getTime() > checkInLimit.getTime()) {
        return { applied: false, assignments: [], displacedAssignments: [] };
    }

    const tokenNumber = normalizeSequenceNumber(
        current.original_token_number ?? current.token_number ?? current.current_token_number
    );
    if (tokenNumber === Number.MAX_SAFE_INTEGER) {
        return { applied: false, assignments: [], displacedAssignments: [] };
    }

    const assignedRows = queueRows
        .filter((row) => (
            Number(row?.appointment_id || 0) !== appointmentId
            && Boolean(row?.checked_in_at)
            && READY_QUEUE_STATUSES.includes(row?.queue_status)
            && !row?.actual_called_at
            && !row?.actual_started_at
            && !row?.actual_completed_at
            && normalizeSequenceNumber(row?.live_queue_assigned_position) !== Number.MAX_SAFE_INTEGER
        ))
        .sort((left, right) => {
            const assignedOrder = comparePersistedLiveQueueAssignments(left, right);
            return assignedOrder !== 0 ? assignedOrder : compareTokenNumbers(left, right);
        });
    const hasActiveAssignmentCohort = assignedRows.length > 0;
    const hasUnarrivedLowerToken = queueRows.some((row) => (
        Number(row?.appointment_id || 0) !== appointmentId
        && !row?.checked_in_at
        && ACTIVE_QUEUE_STATUSES.includes(row?.queue_status)
        && normalizeSequenceNumber(
            row?.original_token_number ?? row?.token_number ?? row?.current_token_number
        ) < tokenNumber
    ));
    const startsEarlyArrivalCohort = !hasActiveAssignmentCohort
        && hasUnarrivedLowerToken
        && plannedStartAt instanceof Date
        && checkInDate.getTime() < plannedStartAt.getTime();

    if (!hasActiveAssignmentCohort && !startsEarlyArrivalCohort) {
        return { applied: false, assignments: [], displacedAssignments: [] };
    }

    let insertionIndex = assignedRows.reduce((lastLowerIndex, row, index) => {
        const rowTokenNumber = normalizeSequenceNumber(
            row?.original_token_number ?? row?.token_number ?? row?.current_token_number
        );
        return rowTokenNumber < tokenNumber ? index + 1 : lastLowerIndex;
    }, 0);

    assignedRows.forEach((row, index) => {
        const rowTokenNumber = normalizeSequenceNumber(
            row?.original_token_number ?? row?.token_number ?? row?.current_token_number
        );
        const displacementCount = Number(row?.live_queue_displacement_count || 0);
        if (
            index >= insertionIndex
            && rowTokenNumber > tokenNumber
            && Number(row?.live_queue_early_arrival || 0) === 1
            && displacementCount >= MAX_POST_PROTECTED_SHUFFLES
        ) {
            insertionIndex = index + 1;
        }
    });

    const orderedRows = [...assignedRows];
    orderedRows.splice(insertionIndex, 0, {
        ...current,
        checked_in_at: formatDateTimeForSql(checkInDate),
        live_queue_early_arrival: startsEarlyArrivalCohort ? 1 : Number(current.live_queue_early_arrival || 0),
        live_queue_displacement_count: Number(current.live_queue_displacement_count || 0),
    });

    const oldPositionById = new Map(assignedRows.map((row) => [
        Number(row.appointment_id),
        Number(row.live_queue_assigned_position),
    ]));
    const assignments = orderedRows.map((row, index) => {
        const rowAppointmentId = Number(row.appointment_id);
        const oldPosition = oldPositionById.get(rowAppointmentId) || null;
        const assignedPosition = index + 1;
        const rowTokenNumber = normalizeSequenceNumber(
            row?.original_token_number ?? row?.token_number ?? row?.current_token_number
        );
        const wasDisplaced = rowAppointmentId !== appointmentId
            && oldPosition !== null
            && assignedPosition > oldPosition
            && rowTokenNumber > tokenNumber
            && Number(row?.live_queue_early_arrival || 0) === 1;
        const displacementCount = Math.min(
            Number(row?.live_queue_displacement_count || 0) + (wasDisplaced ? 1 : 0),
            MAX_POST_PROTECTED_SHUFFLES
        );

        return {
            appointmentId: rowAppointmentId,
            oldPosition,
            assignedPosition,
            displacementCount,
            earlyArrival: Number(row?.live_queue_early_arrival || 0) === 1,
            wasDisplaced,
            isLocked: displacementCount >= MAX_POST_PROTECTED_SHUFFLES,
        };
    });
    const currentAssignment = assignments.find((assignment) => assignment.appointmentId === appointmentId);

    return {
        applied: true,
        assignments,
        displacedAssignments: assignments.filter((assignment) => assignment.wasDisplaced),
        assignedPosition: currentAssignment?.assignedPosition || null,
        displacementCount: currentAssignment?.displacementCount || 0,
        isLocked: Boolean(currentAssignment?.isLocked),
        startedByEarlyArrival: startsEarlyArrivalCohort,
    };
};

const isVisibleQueueItem = (item) => (
    Boolean(item)
    && item.queue_bucket !== 'NOT_ARRIVED'
    && !(item.is_on_hold && !item.present_now)
);

const enforceMaxShuffleLimitOnRemainingItems = (remainingItems = []) => {
    if (!Array.isArray(remainingItems) || remainingItems.length <= 1) {
        return remainingItems || [];
    }

    return remainingItems.map((item) => {
        const currentShuffleCount = Number(
            item?.live_queue_displacement_count ?? item?.shuffle_count ?? 0
        );
        const originalTokenNumber = normalizeSequenceNumber(item?.original_token_number ?? item?.token_number);
        const currentTokenNumber = normalizeSequenceNumber(item?.current_token_number ?? item?.token_number);

        const isShuffledFromOriginal = originalTokenNumber !== Number.MAX_SAFE_INTEGER
            && currentTokenNumber !== Number.MAX_SAFE_INTEGER
            && originalTokenNumber !== currentTokenNumber;

        let effectiveShuffleCount = currentShuffleCount;
        if (isShuffledFromOriginal && effectiveShuffleCount === 0) {
            effectiveShuffleCount = 1;
        }

        const cappedShuffleCount = Math.min(effectiveShuffleCount, MAX_POST_PROTECTED_SHUFFLES);

        return {
            ...item,
            shuffle_count: cappedShuffleCount,
            is_shuffle_locked: cappedShuffleCount >= MAX_POST_PROTECTED_SHUFFLES,
        };
    });
};

const applyProtectedVisibleQueueWindow = (
    runtimeItems = [],
    protectedWindowAppointmentIds = [],
) => {
    const protectedAppointmentIds = normalizeProtectedWindowAppointmentIds(protectedWindowAppointmentIds);

    if (protectedAppointmentIds.length === 0 || runtimeItems.length === 0) {
        return runtimeItems;
    }

    const runtimeItemById = new Map(
        runtimeItems.map((item) => [Number(item?.appointment_id || 0), item])
    );
    const pinnedItems = runtimeItems.filter((item) => (
        item?.queue_bucket === 'IN_PROGRESS'
        || item?.queue_bucket === 'CALLED'
    ));
    const pinnedIds = new Set(pinnedItems.map((item) => Number(item?.appointment_id || 0)));
    const protectedVisibleItems = protectedAppointmentIds
        .map((appointmentId) => runtimeItemById.get(appointmentId))
        .filter((item) => item && isVisibleQueueItem(item) && !pinnedIds.has(Number(item.appointment_id)));
    const protectedVisibleIds = new Set(
        protectedVisibleItems.map((item) => Number(item.appointment_id))
    );

    if (protectedVisibleItems.length === 0) {
        return runtimeItems;
    }

    const remainingItems = runtimeItems.filter((item) => {
        const appointmentId = Number(item?.appointment_id || 0);

        return !pinnedIds.has(appointmentId) && !protectedVisibleIds.has(appointmentId);
    });

    const enforcedRemainingItems = enforceMaxShuffleLimitOnRemainingItems(remainingItems);

    return [
        ...pinnedItems,
        ...protectedVisibleItems,
        ...enforcedRemainingItems,
    ];
};

const isQueueItemPresentOnOrBeforeEffectiveTime = (item) => {
    if (!item?.checked_in_at) {
        return false;
    }

    const checkedInAt = parseMysqlDateTime(item.checked_in_at);
    const plannedStartAt = parseMysqlDateTime(item?.planned_start_at || null);

    if (
        !(checkedInAt instanceof Date)
        || Number.isNaN(checkedInAt.getTime())
        || !(plannedStartAt instanceof Date)
        || Number.isNaN(plannedStartAt.getTime())
    ) {
        return false;
    }

    const bufferLimitTime = plannedStartAt.getTime() + CHECK_IN_GRACE_MINUTES * 60 * 1000;
    return checkedInAt.getTime() <= bufferLimitTime;
};

const isLateQueueArrival = (item) => (
    Boolean(item?.checked_in_at)
    && !isQueueItemPresentOnOrBeforeEffectiveTime(item)
);

const isRuntimeHoldCandidate = (item) => (
    READY_QUEUE_STATUSES.includes(item?.queue_status)
    && isLateQueueArrival(item)
);

const resolveQueueServiceOrderValue = (item) => normalizeDateOrderValue(
    item?.actual_called_at
    || item?.actual_started_at
    || item?.actual_completed_at
    || null
);

const isBlankSettlementSlot = (item) => {
    if (!item) {
        return false;
    }

    if (isVirtualBlankSlot(item)) {
        return true;
    }

    return !item.checked_in_at && item.queue_status === QUEUE_STATUS.BOOKED;
};

const normalizeTokenOrder = (item) => normalizeSequenceNumber(
    item?.current_token_number ?? item?.token_number
);

const firstValidSequenceNumber = (...values) => {
    for (const value of values) {
        const normalized = normalizeSequenceNumber(value);
        if (normalized !== Number.MAX_SAFE_INTEGER) {
            return normalized;
        }
    }

    return Number.MAX_SAFE_INTEGER;
};

const resolveRuntimeBoundaryOrderValue = (item) => normalizeDateOrderValue(
    item?.actual_started_at
    || item?.actual_called_at
    || item?.live_estimated_start_at
    || item?.planned_start_at
    || item?.estimated_start_at
    || null
);

const resolveRuntimeBoundaryToken = (item, settlementSlots = []) => {
    const settledToken = firstValidSequenceNumber(item?.runtime_settled_token_number);
    if (settledToken !== Number.MAX_SAFE_INTEGER) {
        return settledToken;
    }

    const itemToken = normalizeTokenOrder(item);
    const itemOrder = resolveRuntimeBoundaryOrderValue(item);
    const settledBoundaryFromTimeline = settlementSlots
        .filter((slot) => (
            slot.token !== Number.MAX_SAFE_INTEGER
            && slot.order !== Number.MAX_SAFE_INTEGER
            && itemOrder !== Number.MAX_SAFE_INTEGER
            && slot.token > itemToken
            && slot.order <= itemOrder
        ))
        .sort((left, right) => right.token - left.token)[0]?.token;

    return firstValidSequenceNumber(settledBoundaryFromTimeline, itemToken);
};

const buildRuntimeScheduleState = ({
    queueItems = [],
    timelineItems = [],
    currentRunningAppointmentId = null,
    sessionStatus = null,
    now = new Date(),
}) => {
    const normalizedNow = now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date();
    const normalizedNowOrder = normalizedNow.getTime();
    const currentRunningId = Number(currentRunningAppointmentId || 0);
    const activeItems = queueItems || [];
    const effectiveTimelineItems = (timelineItems && timelineItems.length > 0 ? [...timelineItems] : [...activeItems])
        .filter(Boolean);
    const effectiveTimelineKeys = new Set(
        effectiveTimelineItems.map((item) => [
            item?.appointment_id || '',
            normalizeTokenOrder(item),
        ].join(':'))
    );

    activeItems
        .filter(isBlankSettlementSlot)
        .forEach((item) => {
            const key = [
                item?.appointment_id || '',
                normalizeTokenOrder(item),
            ].join(':');

            if (!effectiveTimelineKeys.has(key)) {
                effectiveTimelineItems.push(item);
                effectiveTimelineKeys.add(key);
            }
        });

    const timelineEntries = effectiveTimelineItems
        .filter((item) => resolveEffectiveRuntimeEtaValue(item) !== Number.MAX_SAFE_INTEGER)
        .sort(compareRuntimeTimelineItems);

    const schedulePointer = [...timelineEntries]
        .reverse()
        .find((item) => resolveEffectiveRuntimeEtaValue(item) <= normalizedNowOrder)
        || timelineEntries[0]
        || null;

    const activeQueueById = new Map(
        activeItems.map((item) => [Number(item.appointment_id), item])
    );
    const scheduledDueActiveItem = schedulePointer
        ? activeQueueById.get(Number(schedulePointer.appointment_id)) || null
        : null;

    const holdQueue = activeItems
        .filter((item) => {
            const appointmentId = Number(item.appointment_id || 0);
            const effectiveRuntimeOrder = resolveEffectiveRuntimeEtaValue(item);

            if (!appointmentId || effectiveRuntimeOrder === Number.MAX_SAFE_INTEGER) {
                return false;
            }

            if (appointmentId === currentRunningId || item.queue_bucket === 'IN_PROGRESS' || item.queue_bucket === 'CALLED') {
                return false;
            }

            return isRuntimeHoldCandidate(item);
        })
        .sort(compareHoldQueueItems)
        .map((item, index) => ({
            ...item,
            is_on_hold: true,
            hold_rank: index + 1,
            hold_state: 'PRESENT',
            present_now: true,
            present_on_time: isQueueItemPresentOnOrBeforeEffectiveTime(item),
            hold_waiting_minutes: getHoldWaitingMinutes(item, normalizedNow),
            hold_priority_reason: 'CHECKED_IN_AFTER_GRACE_WINDOW',
            scheduled_due: scheduledDueActiveItem
                ? Number(item.appointment_id) === Number(scheduledDueActiveItem.appointment_id)
                : false,
        }));

    const holdById = new Map(
        holdQueue.map((item) => [Number(item.appointment_id), item])
    );

    return {
        timelineEntries,
        schedulePointer,
        scheduledDueActiveItem,
        holdQueue,
        holdById,
    };
};

const isSessionPinnedRunningAppointment = (
    item,
    currentRunningAppointmentId = null,
    sessionStatus = null,
) => (
    Boolean(item)
    && sessionStatus === SESSION_STATUS.RUNNING
    && Boolean(currentRunningAppointmentId)
    && Number(item.appointment_id) === Number(currentRunningAppointmentId)
    && Boolean(item.actual_called_at || item.actual_started_at || item.queue_status === QUEUE_STATUS.IN_PROGRESS)
);

const deriveQueueBucket = (item, {
    currentRunningAppointmentId = null,
    sessionStatus = null,
} = {}) => {
    if (!item) {
        return null;
    }

    if (item.queue_status === QUEUE_STATUS.IN_PROGRESS) {
        return sessionStatus === SESSION_STATUS.RUNNING ? 'IN_PROGRESS' : 'READY';
    }

    if (
        isSessionPinnedRunningAppointment(item, currentRunningAppointmentId, sessionStatus)
    ) {
        return 'IN_PROGRESS';
    }

    if (item.queue_status === QUEUE_STATUS.WAITING && item.actual_called_at) {
        return 'CALLED';
    }

    if (item.checked_in_at && READY_QUEUE_STATUSES.includes(item.queue_status)) {
        return 'READY';
    }

    return 'NOT_ARRIVED';
};

const buildDerivedLiveQueueView = ({
    queueItems = [],
    timelineItems = [],
    currentRunningAppointmentId = null,
    sessionStatus = null,
    now = new Date(),
    protectedWindowAppointmentIds = [],
}) => {
    const normalizedItems = queueItems.map((item) => ({
        ...item,
        queue_bucket: deriveQueueBucket(item, { currentRunningAppointmentId, sessionStatus }),
        live_queue_position: null,
        ready_queue_position: null,
        runtime_priority_rank: null,
        ...buildRuntimePriorityMeta(item),
    }));

    const currentRunning = normalizedItems.find(
        (item) => item.queue_bucket === 'IN_PROGRESS'
    ) || null;

    const runtimeScheduleState = buildRuntimeScheduleState({
        queueItems: normalizedItems,
        timelineItems,
        currentRunningAppointmentId: currentRunning?.appointment_id || currentRunningAppointmentId || null,
        sessionStatus,
        now,
    });

    const calledQueue = normalizedItems
        .filter((item) => item.queue_bucket === 'CALLED')
        .sort((left, right) => {
            const leftCalledAt = normalizeDateOrderValue(left.actual_called_at);
            const rightCalledAt = normalizeDateOrderValue(right.actual_called_at);

            if (leftCalledAt !== rightCalledAt) {
                return leftCalledAt - rightCalledAt;
            }

            return compareTokenNumbers(left, right);
        });

    const holdQueue = runtimeScheduleState.holdQueue.map((holdItem) => ({
        ...(normalizedItems.find(
            (item) => Number(item.appointment_id) === Number(holdItem.appointment_id)
        ) || holdItem),
        ...holdItem,
    }));

    const holdById = new Map(
        holdQueue.map((item) => [Number(item.appointment_id), item])
    );

    const readyQueue = normalizedItems
        .filter((item) => item.queue_bucket === 'READY' && !holdById.has(Number(item.appointment_id)))
        .sort(compareRuntimeTimelineItems)
        .map((item, index) => ({
            ...item,
            ready_queue_position: index + 1,
        }));

    const liveQueueSeed = (currentRunning ? 1 : 0) + calledQueue.length + 1;

    const readyQueueById = new Map(
        readyQueue.map((item, index) => [
            Number(item.appointment_id),
            {
                live_queue_position: index + liveQueueSeed,
                ready_queue_position: index + 1,
            },
        ])
    );

    const decoratedItems = normalizedItems.map((item) => {
        if (currentRunning && Number(item.appointment_id) === Number(currentRunning.appointment_id)) {
            return {
                ...item,
                live_queue_position: 1,
                ready_queue_position: 0,
            };
        }

        const readyPosition = readyQueueById.get(Number(item.appointment_id));
        if (readyPosition) {
            return {
                ...item,
                live_queue_position: readyPosition.live_queue_position,
                ready_queue_position: readyPosition.ready_queue_position,
            };
        }

        return item;
    });

    const decoratedItemsWithHold = decoratedItems.map((item) => (
        holdById.has(Number(item.appointment_id))
            ? {
                ...item,
                ...holdById.get(Number(item.appointment_id)),
            }
            : item
    ));

    const decoratedById = new Map(
        decoratedItemsWithHold.map((item) => [Number(item.appointment_id), item])
    );

    const sortedCalledQueue = calledQueue.map((item) => decoratedById.get(Number(item.appointment_id)) || item);
    const sortedNotArrivedQueue = decoratedItemsWithHold
        .filter((item) => item.queue_bucket === 'NOT_ARRIVED' && !holdById.has(Number(item.appointment_id)))
        .sort(compareTokenNumbers);
    const serviceableOrderedQueue = [];
    const serviceableSeen = new Set();

    const pushServiceableItem = (item) => {
        const appointmentId = Number(item?.appointment_id || 0);
        if (!appointmentId || serviceableSeen.has(appointmentId)) {
            return;
        }

        serviceableSeen.add(appointmentId);
        serviceableOrderedQueue.push(item);
    };

    const serviceTokenSlots = readyQueue
        .map((item) => ({
            item,
            token: normalizeTokenOrder(item),
            order: resolveEffectiveRuntimeEtaValue(item),
        }))
        .filter((slot) => (
            slot.token !== Number.MAX_SAFE_INTEGER
            && slot.order !== Number.MAX_SAFE_INTEGER
        ))
        .sort((left, right) => left.token - right.token);
    const currentRunningItem = currentRunning
        ? decoratedById.get(Number(currentRunning.appointment_id)) || currentRunning
        : null;
    let currentRunningBoundaryToken = currentRunningItem
        ? normalizeTokenOrder(currentRunningItem)
        : null;
    const serviceHistoryItems = runtimeScheduleState.timelineEntries
        .filter((item) => (
            resolveQueueServiceOrderValue(item) !== Number.MAX_SAFE_INTEGER
            && normalizeTokenOrder(item) !== Number.MAX_SAFE_INTEGER
        ))
        .sort((left, right) => {
            const leftOrder = resolveQueueServiceOrderValue(left);
            const rightOrder = resolveQueueServiceOrderValue(right);

            if (leftOrder !== rightOrder) {
                return leftOrder - rightOrder;
            }

            return normalizeTokenOrder(left) - normalizeTokenOrder(right);
        });
    const availableBlankSettlementSlots = runtimeScheduleState.timelineEntries
        .filter((item) => (
            isBlankSettlementSlot(item)
            || (
                serviceHistoryItems.length > 0
                && isLateQueueArrival(item)
            )
        ))
        .map((item) => ({
            item,
            token: normalizeTokenOrder(item),
            order: resolveEffectiveRuntimeEtaValue(item),
        }))
        .filter((slot) => (
            slot.token !== Number.MAX_SAFE_INTEGER
            && slot.order !== Number.MAX_SAFE_INTEGER
        ))
        .sort((left, right) => {
            if (left.token !== right.token) {
                return left.token - right.token;
            }

            return left.order - right.order;
        });
    const consumeSettlementSlot = (settlementBoundaryToken, settlingItem = null) => {
        const settlingItemToken = settlingItem
            ? normalizeTokenOrder(settlingItem)
            : null;
        const lowerProtectedServiceBoundaryToken = settlingItemToken !== null
            && settlingItemToken !== Number.MAX_SAFE_INTEGER
            ? serviceTokenSlots
                .filter((slot) => slot.token < settlingItemToken)
                .sort((left, right) => right.token - left.token)[0]?.token
            : null;
        const effectiveSettlementBoundaryToken = Math.max(
            settlementBoundaryToken || 0,
            lowerProtectedServiceBoundaryToken || 0
        );
        const nextServiceToken = serviceTokenSlots.find(
            (slot) => slot.token > effectiveSettlementBoundaryToken
        ) || null;
        const canSettleBeforeNextService = !nextServiceToken
            || settlingItemToken === null
            || settlingItemToken === Number.MAX_SAFE_INTEGER
            || settlingItemToken < nextServiceToken.token;
        const blankBeforeNextService = nextServiceToken && canSettleBeforeNextService
            ? availableBlankSettlementSlots
                .map((slot, index) => ({ ...slot, index }))
                .filter((slot) => (
                    slot.token > effectiveSettlementBoundaryToken
                    && slot.token < nextServiceToken.token
                ))[0] || null
            : null;
        const nextBlankMinimumToken = nextServiceToken && !canSettleBeforeNextService
            ? nextServiceToken.token
            : effectiveSettlementBoundaryToken;
        const nextBlankAfterBoundary = availableBlankSettlementSlots
            .map((slot, index) => ({ ...slot, index }))
            .find((slot) => slot.token > nextBlankMinimumToken) || null;
        const assignedBlankSlot = blankBeforeNextService || nextBlankAfterBoundary;

        if (assignedBlankSlot) {
            availableBlankSettlementSlots.splice(assignedBlankSlot.index, 1);
        }

        return assignedBlankSlot;
    };

    if (serviceHistoryItems.length > 0) {
        let committedBoundaryToken = 0;

        for (const committedItem of serviceHistoryItems) {
            if (!isLateQueueArrival(committedItem)) {
                committedBoundaryToken = normalizeTokenOrder(committedItem);
                continue;
            }

            const assignedBlankSlot = consumeSettlementSlot(committedBoundaryToken, committedItem);
            committedBoundaryToken = assignedBlankSlot?.token || committedBoundaryToken;
        }

        currentRunningBoundaryToken = committedBoundaryToken || currentRunningBoundaryToken;
    }

    let rollingHoldSettlementBoundaryToken = currentRunningBoundaryToken;
    const remainingPresentHoldQueue = holdQueue
        .filter((item) => item.present_now)
        .map((item) => decoratedById.get(Number(item.appointment_id)) || item)
        .sort(compareHoldQueueItems)
        .map((item) => {
            const itemToken = normalizeTokenOrder(item);
            const settlementBoundaryToken = rollingHoldSettlementBoundaryToken ?? itemToken;
            const assignedBlankSlot = consumeSettlementSlot(settlementBoundaryToken, item);
            rollingHoldSettlementBoundaryToken = assignedBlankSlot?.token || rollingHoldSettlementBoundaryToken;

            return {
                ...item,
                runtime_settled_order: assignedBlankSlot?.order || null,
                runtime_settled_token_number: assignedBlankSlot?.token || null,
            };
        });

    [
        ...readyQueue,
        ...remainingPresentHoldQueue,
    ]
        .sort((left, right) => {
            const leftIsPresentHold = Boolean(left.is_on_hold && left.present_now);
            const rightIsPresentHold = Boolean(right.is_on_hold && right.present_now);
            const leftToken = normalizeSequenceNumber(left.current_token_number ?? left.token_number);
            const rightToken = normalizeSequenceNumber(right.current_token_number ?? right.token_number);
            const leftRuntimeToken = leftIsPresentHold
                ? firstValidSequenceNumber(left.runtime_settled_token_number)
                : leftToken;
            const rightRuntimeToken = rightIsPresentHold
                ? firstValidSequenceNumber(right.runtime_settled_token_number)
                : rightToken;

            const leftOrder = left.is_on_hold && left.present_now
                ? (left.runtime_settled_order || Number.MAX_SAFE_INTEGER)
                : resolveEffectiveRuntimeEtaValue(left);
            const rightOrder = right.is_on_hold && right.present_now
                ? (right.runtime_settled_order || Number.MAX_SAFE_INTEGER)
                : resolveEffectiveRuntimeEtaValue(right);

            if (leftRuntimeToken !== rightRuntimeToken) {
                return leftRuntimeToken - rightRuntimeToken;
            }

            if (leftOrder !== rightOrder) {
                return leftOrder - rightOrder;
            }

            if (leftIsPresentHold && rightIsPresentHold) {
                return compareHoldQueueItems(left, right);
            }

            if (leftToken !== rightToken) {
                return leftToken - rightToken;
            }

            return compareRuntimeTimelineItems(left, right);
        })
        .forEach((item) => pushServiceableItem(item));

    const holdAbsentQueue = holdQueue
        .filter((item) => !item.present_now)
        .map((item) => decoratedById.get(Number(item.appointment_id)) || item);

    const runtimeItemsBeforeRank = [
        ...(currentRunning ? [decoratedById.get(Number(currentRunning.appointment_id)) || currentRunning] : []),
        ...sortedCalledQueue,
        ...serviceableOrderedQueue,
        ...holdAbsentQueue,
        ...sortedNotArrivedQueue,
    ];
    const runtimeOrderedItems = applyProtectedVisibleQueueWindow(
        runtimeItemsBeforeRank,
        protectedWindowAppointmentIds,
    ).map((item, index) => ({
        ...item,
        runtime_priority_rank: index + 1,
        live_queue_position: item.queue_bucket === 'NOT_ARRIVED' || (item.is_on_hold && !item.present_now)
            ? item.live_queue_position
            : index + 1,
    }));

    const runtimeOrderedById = new Map(
        runtimeOrderedItems.map((item) => [Number(item.appointment_id), item])
    );
    const runtimeReadyQueue = serviceableOrderedQueue
        .map((item) => runtimeOrderedById.get(Number(item.appointment_id)) || item)
        .sort((left, right) => (left.live_queue_position || 999999) - (right.live_queue_position || 999999));
    const nextRuntimeCandidate = runtimeReadyQueue[0] || null;

    return {
        items: decoratedItemsWithHold.map((item) => runtimeOrderedById.get(Number(item.appointment_id)) || item),
        runtimeOrderedItems,
        currentRunning: currentRunning ? runtimeOrderedById.get(Number(currentRunning.appointment_id)) || currentRunning : null,
        readyQueue: runtimeReadyQueue,
        calledQueue: sortedCalledQueue.map((item) => runtimeOrderedById.get(Number(item.appointment_id)) || item),
        holdQueue: holdQueue.map((item) => runtimeOrderedById.get(Number(item.appointment_id)) || item),
        notArrivedQueue: sortedNotArrivedQueue.map((item) => runtimeOrderedById.get(Number(item.appointment_id)) || item),
        nextRuntimeCandidate,
        nextRuntimeAssignmentMode: nextRuntimeCandidate?.is_on_hold
            ? 'HOLD_REASSIGN'
            : (nextRuntimeCandidate ? 'SCHEDULED_PRESENT' : null),
        scheduledDueToken: runtimeScheduleState.scheduledDueActiveItem
            ? runtimeOrderedById.get(Number(runtimeScheduleState.scheduledDueActiveItem.appointment_id))
                || runtimeScheduleState.scheduledDueActiveItem
            : null,
    };
};

const toFrozenSequenceBaseItem = (item = {}) => {
    const hasCheckedIn = Boolean(item?.checked_in_at);

    return {
        ...item,
        queue_status: hasCheckedIn ? QUEUE_STATUS.CHECKED_IN : QUEUE_STATUS.BOOKED,
        actual_called_at: null,
        actual_started_at: null,
        actual_completed_at: null,
        live_estimated_start_at: null,
        live_estimated_end_at: null,
        live_wait_minutes_snapshot: null,
        live_eta_updated_at: null,
    };
};

const buildFrozenDisplaySequenceView = ({
    queueItems = [],
    timelineItems = [],
    sessionStatus = SESSION_STATUS.RUNNING,
    now = new Date(),
    protectedWindowAppointmentIds = [],
}) => {
    const queueItemById = new Map(
        (queueItems || [])
            .filter((item) => Number(item?.appointment_id || 0) > 0)
            .map((item) => [Number(item.appointment_id), item])
    );
    const baseRowsById = new Map();
    const blankRows = [];

    for (const rawItem of timelineItems || []) {
        if (!rawItem) {
            continue;
        }

        if (isVirtualBlankSlot(rawItem)) {
            blankRows.push(toFrozenSequenceBaseItem(rawItem));
            continue;
        }

        const appointmentId = Number(rawItem.appointment_id || 0);
        if (!appointmentId || appointmentId < 0) {
            continue;
        }

        baseRowsById.set(
            appointmentId,
            toFrozenSequenceBaseItem({
                ...rawItem,
                ...(queueItemById.get(appointmentId) || {}),
                appointment_id: appointmentId,
            })
        );
    }

    for (const rawItem of queueItems || []) {
        const appointmentId = Number(rawItem?.appointment_id || 0);
        if (!appointmentId || appointmentId < 0 || baseRowsById.has(appointmentId)) {
            continue;
        }

        baseRowsById.set(appointmentId, toFrozenSequenceBaseItem(rawItem));
    }

    const baseQueueItems = Array.from(baseRowsById.values());

    return buildDerivedLiveQueueView({
        queueItems: baseQueueItems,
        timelineItems: [...baseQueueItems, ...blankRows],
        currentRunningAppointmentId: null,
        sessionStatus,
        now,
        protectedWindowAppointmentIds,
    });
};

const applyFrozenDisplaySequenceToDerivedView = ({
    derivedView,
    frozenDisplaySequenceView,
}) => {
    if (!derivedView || !frozenDisplaySequenceView) {
        return derivedView;
    }

    const frozenOrderById = new Map();
    const frozenItemById = new Map();

    (frozenDisplaySequenceView.runtimeOrderedItems || []).forEach((item, index) => {
        const appointmentId = Number(item?.appointment_id || 0);
        if (!appointmentId || appointmentId < 0 || frozenOrderById.has(appointmentId)) {
            return;
        }

        frozenOrderById.set(appointmentId, index + 1);
        frozenItemById.set(appointmentId, item);
    });

    if (frozenOrderById.size === 0) {
        return derivedView;
    }

    const mergeFrozenMeta = (item) => {
        if (!item) {
            return item;
        }

        const appointmentId = Number(item.appointment_id || 0);
        const frozenItem = frozenItemById.get(appointmentId) || null;

        return {
            ...item,
            is_on_hold: frozenItem?.is_on_hold ?? item.is_on_hold,
            hold_rank: frozenItem?.hold_rank ?? item.hold_rank,
            hold_state: frozenItem?.hold_state ?? item.hold_state,
            present_now: frozenItem?.present_now ?? item.present_now,
            present_on_time: frozenItem?.present_on_time ?? item.present_on_time,
            hold_waiting_minutes: frozenItem?.hold_waiting_minutes ?? item.hold_waiting_minutes,
            hold_priority_reason: frozenItem?.hold_priority_reason ?? item.hold_priority_reason,
            runtime_settled_order: frozenItem?.runtime_settled_order ?? item.runtime_settled_order,
            runtime_settled_token_number: frozenItem?.runtime_settled_token_number ?? item.runtime_settled_token_number,
            runtime_frozen_sequence_rank: frozenOrderById.get(appointmentId) || null,
        };
    };

    const frozenSort = (left, right) => {
        const leftOrder = frozenOrderById.get(Number(left?.appointment_id || 0)) || Number.MAX_SAFE_INTEGER;
        const rightOrder = frozenOrderById.get(Number(right?.appointment_id || 0)) || Number.MAX_SAFE_INTEGER;

        if (leftOrder !== rightOrder) {
            return leftOrder - rightOrder;
        }

        return compareRuntimeTimelineItems(left, right);
    };

    const currentRunning = mergeFrozenMeta(derivedView.currentRunning || null);
    const currentId = Number(currentRunning?.appointment_id || 0);
    const calledQueue = (derivedView.calledQueue || [])
        .map(mergeFrozenMeta)
        .filter((item) => Number(item?.appointment_id || 0) !== currentId)
        .sort(frozenSort);
    const calledIds = new Set(calledQueue.map((item) => Number(item.appointment_id || 0)));
    const readyQueue = (derivedView.readyQueue || [])
        .map(mergeFrozenMeta)
        .filter((item) => {
            const appointmentId = Number(item?.appointment_id || 0);
            return appointmentId !== currentId && !calledIds.has(appointmentId);
        })
        .sort(frozenSort);
    const readyIds = new Set(readyQueue.map((item) => Number(item.appointment_id || 0)));
    const notArrivedQueue = (derivedView.notArrivedQueue || [])
        .map(mergeFrozenMeta)
        .filter((item) => {
            const appointmentId = Number(item?.appointment_id || 0);
            return appointmentId !== currentId && !calledIds.has(appointmentId) && !readyIds.has(appointmentId);
        })
        .sort(frozenSort);

    const orderedBeforeRank = [
        ...(currentRunning ? [currentRunning] : []),
        ...calledQueue,
        ...readyQueue,
        ...notArrivedQueue,
    ];
    const readyPositionById = new Map(
        readyQueue.map((item, index) => [Number(item.appointment_id), index + 1])
    );
    const rankedById = new Map();
    const runtimeOrderedItems = orderedBeforeRank.map((item, index) => {
        const isNotArrived = item.queue_bucket === 'NOT_ARRIVED' || !item.checked_in_at;
        const rankedItem = {
            ...item,
            runtime_priority_rank: index + 1,
            live_queue_position: isNotArrived ? null : index + 1,
            ready_queue_position: readyPositionById.get(Number(item.appointment_id)) || item.ready_queue_position,
        };

        rankedById.set(Number(item.appointment_id), rankedItem);
        return rankedItem;
    });

    const resolveRankedItem = (item) => (
        rankedById.get(Number(item?.appointment_id || 0)) || mergeFrozenMeta(item)
    );
    const finalReadyQueue = readyQueue.map(resolveRankedItem);
    const finalCalledQueue = calledQueue.map(resolveRankedItem);
    const finalHoldQueue = (derivedView.holdQueue || [])
        .map(resolveRankedItem)
        .filter((item) => item?.is_on_hold)
        .sort(frozenSort);
    const finalNotArrivedQueue = notArrivedQueue.map(resolveRankedItem);
    const nextRuntimeCandidate = finalReadyQueue[0] || null;

    return {
        ...derivedView,
        items: runtimeOrderedItems,
        runtimeOrderedItems,
        currentRunning: currentRunning ? resolveRankedItem(currentRunning) : null,
        readyQueue: finalReadyQueue,
        calledQueue: finalCalledQueue,
        holdQueue: finalHoldQueue,
        notArrivedQueue: finalNotArrivedQueue,
        nextRuntimeCandidate,
        nextRuntimeAssignmentMode: nextRuntimeCandidate?.is_on_hold
            ? 'HOLD_REASSIGN'
            : (nextRuntimeCandidate ? 'SCHEDULED_PRESENT' : null),
        scheduledDueToken: derivedView.scheduledDueToken
            ? resolveRankedItem(derivedView.scheduledDueToken)
            : null,
    };
};

const buildCurrentQueueTimingProjection = ({
    runtimeOrderedItems = [],
    sessionStatus = null,
    currentRunningAppointmentId = null,
    now = new Date(),
    defaultConsultMinutes = 15,
}) => {
    const normalizedNow = now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date();
    const isSessionRunning = sessionStatus === SESSION_STATUS.RUNNING;
    let cursor = isSessionRunning ? normalizedNow : null;

    return runtimeOrderedItems.map((item, index) => {
        const consultMinutes = resolveConsultMinutes(item?.consult_minutes, defaultConsultMinutes);
        const isCurrentRunning = item?.queue_bucket === 'IN_PROGRESS'
            || (
                currentRunningAppointmentId
                && Number(item?.appointment_id) === Number(currentRunningAppointmentId)
            );
        const consumesQueueTime = isCurrentRunning
            || item?.queue_bucket === 'CALLED'
            || (
                Boolean(item?.checked_in_at)
                && READY_QUEUE_STATUSES.includes(item?.queue_status)
            );
        let projectedStartAt = null;
        let projectedEndAt = null;

        if (isSessionRunning && consumesQueueTime) {
            if (isCurrentRunning) {
                projectedStartAt = parseMysqlDateTime(item.actual_started_at)
                    || parseMysqlDateTime(item.actual_called_at)
                    || normalizedNow;
                const expectedEndAt = addMinutes(projectedStartAt, consultMinutes);
                projectedEndAt = expectedEndAt && expectedEndAt > normalizedNow ? expectedEndAt : normalizedNow;
                cursor = projectedEndAt;
            } else {
                projectedStartAt = cursor || normalizedNow;
                projectedEndAt = addMinutes(projectedStartAt, consultMinutes);
                cursor = projectedEndAt;
            }
        }

        return {
            ...item,
            current_queue_position: index + 1,
            current_queue_duration_minutes: consultMinutes,
            current_queue_start_at: formatDateTimeForSql(projectedStartAt),
            current_queue_end_at: formatDateTimeForSql(projectedEndAt),
            current_queue_time_basis: !isSessionRunning
                ? 'WAITING_FOR_RUNNING_SESSION'
                : (
                    consumesQueueTime
                        ? 'CURRENT_PRESENT_QUEUE_TREATMENT_DURATION'
                        : 'NOT_PRESENT_EXCLUDED_FROM_QUEUE_TIME'
                ),
            current_queue_time_generated_at: formatDateTimeForSql(normalizedNow),
        };
    });
};

const normalizeRuntimeAppointmentRow = (row) => decorateTokenFields({
    ...row,
    appointment_id: row?.appointment_id === null || row?.appointment_id === undefined ? null : Number(row.appointment_id),
    fk_patient_id: row?.fk_patient_id === null || row?.fk_patient_id === undefined ? null : Number(row.fk_patient_id),
    fk_branch_id: row?.fk_branch_id === null || row?.fk_branch_id === undefined ? null : Number(row.fk_branch_id),
    fk_treatment_id: row?.fk_treatment_id === null || row?.fk_treatment_id === undefined ? null : Number(row.fk_treatment_id),
    fk_slot_id: row?.fk_slot_id === null || row?.fk_slot_id === undefined ? null : Number(row.fk_slot_id),
    token_number: row?.token_number === null || row?.token_number === undefined ? null : Number(row.token_number),
    current_token_number: row?.current_token_number === null || row?.current_token_number === undefined
        ? (row?.token_number === null || row?.token_number === undefined ? null : Number(row.token_number))
        : Number(row.current_token_number),
    original_token_number: row?.original_token_number === null || row?.original_token_number === undefined ? null : Number(row.original_token_number),
    arrival_sequence: row?.arrival_sequence === null || row?.arrival_sequence === undefined ? null : Number(row.arrival_sequence),
    live_queue_assigned_position: row?.live_queue_assigned_position === null || row?.live_queue_assigned_position === undefined
        ? null
        : Number(row.live_queue_assigned_position),
    live_queue_displacement_count: Number(row?.live_queue_displacement_count || 0),
    live_queue_early_arrival: Number(row?.live_queue_early_arrival || 0),
    live_wait_minutes_snapshot: row?.live_wait_minutes_snapshot === null || row?.live_wait_minutes_snapshot === undefined
        ? null
        : Number(row.live_wait_minutes_snapshot),
}, {});

const API_DATE_TIME_FIELDS = [
    'planned_start_at',
    'planned_end_at',
    'estimated_start_at',
    'estimated_end_at',
    'live_estimated_start_at',
    'live_estimated_end_at',
    'live_eta_updated_at',
    'checked_in_at',
    'actual_called_at',
    'actual_started_at',
    'actual_completed_at',
    'last_queue_event_at',
    'current_queue_start_at',
    'current_queue_end_at',
    'current_queue_time_generated_at',
    'session_started_at',
    'session_ended_at',
    'runtime_anchor_at',
    'last_runtime_recalc_at',
    'auto_call_next_due_at',
];

const formatDateTimeForApi = (value) => {
    if (!value) {
        return null;
    }

    if (value instanceof Date) {
        return formatDateTimeForSql(value);
    }

    const normalized = String(value).trim();
    if (!normalized) {
        return null;
    }

    if (MYSQL_DATETIME_REGEX.test(normalized)) {
        return normalized;
    }

    if (normalized.includes('T')) {
        const parsed = new Date(normalized);
        if (!Number.isNaN(parsed.getTime())) {
            return formatDateTimeForSql(parsed);
        }
    }

    const parsed = parseMysqlDateTime(normalized);
    return parsed ? formatDateTimeForSql(parsed) : value;
};

const serializeQueueDateTimes = (item) => {
    if (!item) {
        return item;
    }

    const serialized = { ...item };
    API_DATE_TIME_FIELDS.forEach((field) => {
        if (Object.prototype.hasOwnProperty.call(serialized, field)) {
            serialized[field] = formatDateTimeForApi(serialized[field]);
        }
    });

    return serialized;
};

const serializeQueueListDateTimes = (items = []) => items.map(serializeQueueDateTimes);

const countCompletedQueueItems = (items = []) => {
    const completedAppointmentIds = new Set();

    for (const item of items || []) {
        const appointmentId = Number(item?.appointment_id || 0);

        if (
            !appointmentId
            || appointmentId < 0
            || item?.is_virtual_blank_slot
            || item?.queue_status !== QUEUE_STATUS.COMPLETED
        ) {
            continue;
        }

        completedAppointmentIds.add(appointmentId);
    }

    return completedAppointmentIds.size;
};

const TERMINAL_QUEUE_STATUSES = [
    QUEUE_STATUS.COMPLETED,
    QUEUE_STATUS.CANCELLED,
    QUEUE_STATUS.NO_SHOW,
    QUEUE_STATUS.SKIPPED,
];

const isTerminalQueueItem = (item = {}) => TERMINAL_QUEUE_STATUSES.includes(item?.queue_status);

const resolveActiveQueuePosition = (item = {}) => {
    if (isTerminalQueueItem(item)) {
        return null;
    }

    const candidates = [
        item.live_queue_position,
        item.current_queue_position,
        item.runtime_priority_rank,
        item.ready_queue_position,
    ];

    for (const candidate of candidates) {
        const position = Number(candidate);

        if (Number.isInteger(position) && position > 0) {
            return position;
        }
    }

    return null;
};

const buildQueuePositionExplanation = ({
    tokenDisplay = null,
    completedBefore = 0,
    activeQueuePosition = null,
    sessionQueuePosition = null,
}) => {
    if (!sessionQueuePosition) {
        return null;
    }

    const completedText = completedBefore === 1
        ? '1 patient is already consulted'
        : `${completedBefore} patients are already consulted`;
    const tokenText = tokenDisplay ? ` for token ${tokenDisplay}` : '';

    return `${completedText} before this token; live queue position is ${activeQueuePosition}, so session position${tokenText} is ${sessionQueuePosition}.`;
};

const decorateSessionQueuePosition = (item = null, completedBefore = 0) => {
    if (!item) {
        return item;
    }

    if (isTerminalQueueItem(item)) {
        return {
            ...item,
            runtime_priority_rank: null,
            live_queue_position: null,
            ready_queue_position: null,
            active_queue_position: null,
            session_queue_position: null,
            queue_position_basis: 'TERMINAL_STATUS_EXCLUDED_FROM_ACTIVE_SEQUENCE',
            position_explanation: null,
        };
    }

    const completedBeforeCount = Math.max(0, Number(completedBefore) || 0);
    const activeQueuePosition = resolveActiveQueuePosition(item);
    const sessionQueuePosition = activeQueuePosition
        ? completedBeforeCount + activeQueuePosition
        : null;
    const tokenDisplay = item.display_token_display
        || item.token_display
        || item.current_token_display
        || item.current_token_number
        || item.token_number
        || null;

    return {
        ...item,
        active_queue_position: activeQueuePosition,
        completed_before: completedBeforeCount,
        session_queue_position: sessionQueuePosition,
        queue_position_basis: sessionQueuePosition
            ? 'COMPLETED_BEFORE_PLUS_ACTIVE_QUEUE_POSITION'
            : 'NOT_IN_ACTIVE_QUEUE_SEQUENCE',
        position_explanation: buildQueuePositionExplanation({
            tokenDisplay,
            completedBefore: completedBeforeCount,
            activeQueuePosition,
            sessionQueuePosition,
        }),
    };
};

const decorateSessionQueuePositions = (items = [], completedBefore = 0) => (
    (items || []).map((item) => decorateSessionQueuePosition(item, completedBefore))
);

const buildPlateBlankTimelineRows = async ({
    execute,
    branchId,
    slotId,
    appointmentDate,
    slotStartTime,
    timelineRows = [],
}) => {
    const occupiedTokenNumbers = new Set();
    timelineRows.forEach((row) => {
        [
            row?.token_number,
            row?.current_token_number,
            row?.original_token_number,
        ].forEach((value) => {
            const tokenNumber = Number(value);
            if (Number.isInteger(tokenNumber) && tokenNumber > 0) {
                occupiedTokenNumbers.add(tokenNumber);
            }
        });
    });

    const plate = await buildEffectiveSlotTokenPlate({
        executor: execute,
        branchId,
        slotId,
        appointmentDate,
        slotStartTime,
    });

    return plate
        .filter((token) => !occupiedTokenNumbers.has(Number(token.token_number)))
        .map((token) => {
            const plannedStartAt = combineDateAndTime(appointmentDate, token.estimated_start_at);

            return {
                appointment_id: -Number(token.token_number),
                is_virtual_blank_slot: true,
                fk_branch_id: Number(branchId),
                fk_slot_id: Number(slotId),
                appointment_date: appointmentDate,
                token_number: Number(token.token_number),
                current_token_number: Number(token.token_number),
                original_token_number: Number(token.token_number),
                queue_status: QUEUE_STATUS.BOOKED,
                checked_in_at: null,
                arrival_sequence: null,
                planned_start_at: formatDateTimeForSql(plannedStartAt),
                live_estimated_start_at: null,
            };
        });
};

const sortAppointmentsByRuntimeQueue = (rows = [], {
    sessions = [],
    timelineRows = [],
    protectedWindowAppointmentIdsByGroup = new Map(),
    now = new Date(),
} = {}) => {
    const groupedRows = new Map();
    const groupedTimelineRows = new Map();
    const groupOrder = [];

    rows.forEach((row) => {
        const normalizedRow = normalizeRuntimeAppointmentRow(row);
        const key = [
            normalizeAppointmentDateKey(normalizedRow?.appointment_date) || '',
            normalizedRow?.fk_branch_id || '',
            normalizedRow?.fk_slot_id || '',
        ].join(':');

        if (!groupedRows.has(key)) {
            groupedRows.set(key, []);
            groupOrder.push(key);
        }

        groupedRows.get(key).push(normalizedRow);
    });

    timelineRows.forEach((row) => {
        const normalizedRow = normalizeRuntimeAppointmentRow(row);
        const key = [
            normalizeAppointmentDateKey(normalizedRow?.appointment_date) || '',
            normalizedRow?.fk_branch_id || '',
            normalizedRow?.fk_slot_id || '',
        ].join(':');

        if (!groupedTimelineRows.has(key)) {
            groupedTimelineRows.set(key, []);
        }

        groupedTimelineRows.get(key).push(normalizedRow);
    });

    const sortedRows = [];
    const sessionByGroupKey = new Map(
        sessions.map((session) => [
            [
                normalizeAppointmentDateKey(session.appointment_date),
                Number(session.fk_branch_id || 0),
                Number(session.fk_slot_id || 0),
            ].join(':'),
            session,
        ])
    );

    for (const key of groupOrder) {
        const [appointmentDate, branchId, slotId] = key.split(':');
        const session = sessionByGroupKey.get([appointmentDate, Number(branchId || 0), Number(slotId || 0)].join(':')) || null;
        const queueItems = groupedRows.get(key) || [];
        const groupTimelineRows = groupedTimelineRows.get(key) || groupedRows.get(key) || [];
        const completedBefore = countCompletedQueueItems(groupTimelineRows);
        const currentRunningAppointment = session?.session_status === SESSION_STATUS.RUNNING
            ? queueItems.find((item) => item.queue_status === QUEUE_STATUS.IN_PROGRESS) || null
            : null;
        const derivedView = buildDerivedLiveQueueView({
            queueItems,
            timelineItems: groupTimelineRows,
            currentRunningAppointmentId: currentRunningAppointment?.appointment_id || session?.current_appointment_id || null,
            sessionStatus: session?.session_status || SESSION_STATUS.NOT_STARTED,
            protectedWindowAppointmentIds: protectedWindowAppointmentIdsByGroup instanceof Map
                ? protectedWindowAppointmentIdsByGroup.get(key) || []
                : protectedWindowAppointmentIdsByGroup?.[key] || [],
            now,
        });

        sortedRows.push(...decorateSessionQueuePositions(derivedView.runtimeOrderedItems, completedBefore));
    }

    return sortedRows;
};

const formatDateString = (date) => {
    if (!date) return '';
    if (date instanceof Date) {
        if (Number.isNaN(date.getTime())) return '';
        return [
            date.getFullYear(),
            pad(date.getMonth() + 1),
            pad(date.getDate()),
        ].join('-');
    }
    const str = String(date).trim();
    if (str.includes('T')) {
        return str.split('T')[0];
    }
    return str;
};

const buildLiveQueueRoom = ({ branchId, slotId, appointmentDate }) => {
    const dateStr = formatDateString(appointmentDate);
    return `live-queue:${branchId}:${slotId}:${dateStr}`;
};

const buildLiveQueueDateRoom = ({ appointmentDate, branchId = null }) => {
    const dateStr = formatDateString(appointmentDate);
    return branchId
        ? `live-queue:${branchId}:date:${dateStr}`
        : `live-queue:date:${dateStr}`;
};

const listTodayLiveQueueSessionsForBroadcast = async ({ branchId = null } = {}) => {
    const params = [];
    let branchCondition = '';

    if (branchId) {
        branchCondition = 'AND fk_branch_id = ?';
        params.push(branchId);
    }

    const rows = await query(
        `SELECT DISTINCT a.fk_branch_id, a.fk_slot_id, a.appointment_date
         FROM tbl_appointments a
         WHERE a.appointment_date = CURDATE()
           AND a.is_active = 1
           AND a.status <> 'Cancelled'
           ${branchCondition}`,
        params
    );

    return rows.map((row) => ({
        branchId: Number(row.fk_branch_id),
        slotId: Number(row.fk_slot_id),
        appointmentDate: row.appointment_date,
    }));
};

const emitDoctorSessionUpdateToLiveQueue = ({
    payload,
    queueSessions = [],
}) => {
    if (!payload) {
        return;
    }

    const rooms = new Set();

    // Always notify the general date room and branch-specific date room for today
    const today = new Date();
    const todayStr = [
        today.getFullYear(),
        pad(today.getMonth() + 1),
        pad(today.getDate()),
    ].join('-');

    rooms.add(
        buildLiveQueueDateRoom({
            appointmentDate: todayStr,
        })
    );

    if (payload.branch_id) {
        rooms.add(
            buildLiveQueueDateRoom({
                branchId: payload.branch_id,
                appointmentDate: todayStr,
            })
        );
    }

    for (const queueSession of queueSessions) {
        if (!queueSession?.appointmentDate) {
            continue;
        }

        if (queueSession.branchId && queueSession.slotId) {
            rooms.add(
                buildLiveQueueRoom({
                    branchId: queueSession.branchId,
                    slotId: queueSession.slotId,
                    appointmentDate: queueSession.appointmentDate,
                })
            );
        }

        if (queueSession.branchId) {
            rooms.add(
                buildLiveQueueDateRoom({
                    branchId: queueSession.branchId,
                    appointmentDate: queueSession.appointmentDate,
                })
            );
        }

        rooms.add(
            buildLiveQueueDateRoom({
                appointmentDate: queueSession.appointmentDate,
            })
        );
    }

    for (const roomName of rooms) {
        emitToPublicLiveQueueRoom(roomName, 'doctor.session.updated', payload);
    }
};

const resolveConsultMinutes = (value, fallback = 15) => {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) {
        return parsed;
    }

    return Number(fallback) > 0 ? Number(fallback) : 15;
};

const getSlotQueueContext = async ({ connection = null, slotId, branchId = null, appointmentDate = null }) => {
    const execute = getExecutor(connection);
    const normalizedSlotId = toPositiveInt(slotId);

    if (!normalizedSlotId) {
        throw new AppError('Valid slot_id is required', 400);
    }

    const rows = await execute(
        `SELECT
            s.id AS slot_id,
            s.fk_branch_id,
            s.slot_name,
            s.start_time,
            s.end_time,
            COALESCE(s.default_consult_minutes, 15) AS default_consult_minutes,
            b.branch_name
         FROM master_slots s
         JOIN master_clinic_branches b ON b.id = s.fk_branch_id
         WHERE s.id = ?
           AND s.is_active = 1
         LIMIT 1`,
        [normalizedSlotId]
    );

    if (rows.length === 0) {
        throw new AppError('Selected slot not found or inactive', 404);
    }

    const slot = rows[0];

    if (branchId && Number(slot.fk_branch_id) !== Number(branchId)) {
        throw new AppError('Selected slot does not belong to the selected branch', 400);
    }

    const resolvedDate = appointmentDate && isValidDateString(appointmentDate)
        ? appointmentDate
        : [
            new Date().getFullYear(),
            pad(new Date().getMonth() + 1),
            pad(new Date().getDate()),
        ].join('-');
    const timing = await resolveEffectiveSlotTiming({
        executor: execute,
        branchId: Number(slot.fk_branch_id),
        slotId: Number(slot.slot_id),
        appointmentDate: resolvedDate,
    });

    return {
        branchId: Number(slot.fk_branch_id),
        branchName: slot.branch_name,
        slotId: Number(slot.slot_id),
        slotName: slot.slot_name,
        slotStartTime: timing.effectiveStartTime,
        slotEndTime: timing.effectiveEndTime,
        defaultSlotStartTime: timing.defaultStartTime,
        defaultSlotEndTime: timing.defaultEndTime,
        hasSlotTimeOverride: timing.hasOverride,
        defaultConsultMinutes: Number(slot.default_consult_minutes) || 15,
        appointmentDate: resolvedDate,
    };
};

const ensureQueueSession = async (connection, {
    branchId,
    slotId,
    appointmentDate,
    actorUserId = null,
}) => {
    const execute = getExecutor(connection);

    await execute(
        `INSERT INTO tbl_live_queue_sessions
         (fk_branch_id, fk_slot_id, appointment_date, session_status, created_by, updated_by)
         VALUES (?, ?, ?, 'NOT_STARTED', ?, ?)
         ON DUPLICATE KEY UPDATE
            updated_by = VALUES(updated_by)`,
        [branchId, slotId, appointmentDate, actorUserId, actorUserId]
    );

    const rows = await execute(
        `SELECT id, fk_branch_id, fk_slot_id, appointment_date, session_status,
                current_appointment_id, current_token_number, session_started_at, session_ended_at,
                runtime_anchor_at, last_runtime_recalc_at, auto_call_next_due_at,
                auto_call_next_reason, queue_revision
         FROM tbl_live_queue_sessions
         WHERE fk_branch_id = ?
           AND fk_slot_id = ?
           AND appointment_date = ?
         LIMIT 1`,
        [branchId, slotId, appointmentDate]
    );

    return rows[0] || null;
};

const recalculateLiveRuntimeProjection = async (connection, {
    branchId,
    slotId,
    appointmentDate,
    actorUserId = null,
    actorIp = null,
    nowOverride = null,
}) => {
    const execute = getExecutor(connection);
    const slot = await getSlotQueueContext({ connection, slotId, branchId, appointmentDate });
    const session = await ensureQueueSession(connection, {
        branchId: slot.branchId,
        slotId: slot.slotId,
        appointmentDate: slot.appointmentDate,
        actorUserId,
    });

    const appointments = await execute(
        `SELECT
            a.appointment_id,
            a.token_number,
            a.current_token_number,
            a.original_token_number,
            a.queue_status,
            a.checked_in_at,
            a.arrival_sequence,
            a.live_queue_assigned_position,
            a.live_queue_displacement_count,
            a.live_queue_early_arrival,
            a.actual_called_at,
            a.actual_started_at,
            a.actual_completed_at,
            a.planned_start_at,
            a.planned_end_at,
            a.live_estimated_start_at,
            a.live_estimated_end_at,
            a.live_wait_minutes_snapshot,
            a.live_eta_updated_at,
            a.created_at,
            COALESCE(a.assigned_slot_duration_minutes, t.estimated_duration_minutes, s.default_consult_minutes, 15) AS consult_minutes
         FROM tbl_appointments a
         JOIN master_treatments t ON t.id = a.fk_treatment_id
         JOIN master_slots s ON s.id = a.fk_slot_id
         WHERE a.fk_branch_id = ?
           AND a.fk_slot_id = ?
           AND a.appointment_date = ?
           AND a.is_active = 1
           AND LOWER(a.status) IN ('pending', 'confirmed')
         ORDER BY a.current_token_number ASC, a.created_at ASC
         FOR UPDATE`,
        [slot.branchId, slot.slotId, slot.appointmentDate]
    );

    const now = nowOverride instanceof Date && !Number.isNaN(nowOverride.getTime())
        ? nowOverride
        : new Date();
    const currentRunningAppointment = appointments.find((item) => item.queue_status === QUEUE_STATUS.IN_PROGRESS)
        || (session?.current_appointment_id
            ? appointments.find((item) => Number(item.appointment_id) === Number(session.current_appointment_id)) || null
            : null);

    const lastCompletedRows = await execute(
        `SELECT appointment_id, actual_completed_at
         FROM tbl_appointments
         WHERE fk_branch_id = ?
           AND fk_slot_id = ?
           AND appointment_date = ?
           AND queue_status = ?
           AND actual_completed_at IS NOT NULL
         ORDER BY actual_completed_at DESC
         LIMIT 1`,
        [slot.branchId, slot.slotId, slot.appointmentDate, QUEUE_STATUS.COMPLETED]
    );
    const lastCompletedAt = lastCompletedRows.length > 0 ? parseMysqlDateTime(lastCompletedRows[0].actual_completed_at) : null;
    const persistedRuntimeAnchorAt = session?.runtime_anchor_at ? parseMysqlDateTime(session.runtime_anchor_at) : null;
    const autoCallNextDueAt = session?.auto_call_next_due_at ? parseMysqlDateTime(session.auto_call_next_due_at) : null;

    const slotBaseStartAt = combineDateAndTime(slot.appointmentDate, slot.slotStartTime);

    // Calculate baseline flat delay (when doctor starts session late)
    let flatDelayMinutes = 0;
    if (session && session.session_status !== 'NOT_STARTED' && session.session_started_at) {
        const sessionStart = parseMysqlDateTime(session.session_started_at);
        if (sessionStart && slotBaseStartAt) {
            flatDelayMinutes = Math.max(0, Math.round((sessionStart.getTime() - slotBaseStartAt.getTime()) / (60 * 1000)));
        }
    }
    
    // Initialize runningTime to the session started time or slot base start time
    let runningTime = slotBaseStartAt;
    if (session && session.session_status !== 'NOT_STARTED' && session.session_started_at) {
        const sessionStart = parseMysqlDateTime(session.session_started_at);
        if (sessionStart) {
            runningTime = sessionStart;
        }
    }

    // Anchor runningTime to the actual completion time of the last completed token
    if (lastCompletedAt && lastCompletedAt.getTime() > runningTime.getTime()) {
        runningTime = lastCompletedAt;
    }

    const plate = await buildEffectiveSlotTokenPlate({
        executor: execute,
        branchId: slot.branchId,
        slotId: slot.slotId,
        appointmentDate: slot.appointmentDate,
        slotStartTime: slot.slotStartTime,
    });

    const updatesByAppointmentId = new Map();
    const protectedWindowAppointmentIds = await getActiveProtectedWindowAppointmentIds(execute, {
        branchId: slot.branchId,
        slotId: slot.slotId,
        appointmentDate: slot.appointmentDate,
    });

    const runtimeOrderedAppointments = buildDerivedLiveQueueView({
        queueItems: appointments,
        timelineItems: appointments,
        currentRunningAppointmentId: currentRunningAppointment?.appointment_id || session?.current_appointment_id || null,
        sessionStatus: session?.session_status || SESSION_STATUS.NOT_STARTED,
        now,
        protectedWindowAppointmentIds,
    }).runtimeOrderedItems;

    for (const appointment of runtimeOrderedAppointments) {
        const tokenNumber = appointment.token_number || appointment.original_token_number || appointment.current_token_number;
        const token = getPlateTokenByNumber(plate, tokenNumber);

        let plannedStart = parseMysqlDateTime(appointment.planned_start_at);
        if (!plannedStart && token) {
            const [year, month, day] = String(slot.appointmentDate).split('-').map(Number);
            const [hour, minute] = String(token.estimated_start_at).split(':').map(Number);
            plannedStart = new Date(year, month - 1, day, hour, minute, 0);
        }
        if (!plannedStart) {
            plannedStart = slotBaseStartAt;
        }

        const consultMinutes = Number(appointment.consult_minutes) || (token ? token.duration_minutes : 15);
        const baselineStart = new Date(plannedStart.getTime() + flatDelayMinutes * 60000);

        let liveEstimatedStartAt = null;
        let liveEstimatedEndAt = null;
        let liveWaitMinutesSnapshot = null;

        if (session && session.session_status !== 'NOT_STARTED') {
            if (appointment.queue_status === QUEUE_STATUS.COMPLETED) {
                const actualCompleted = parseMysqlDateTime(appointment.actual_completed_at) || baselineStart;
                liveEstimatedStartAt = parseMysqlDateTime(appointment.actual_started_at) || parseMysqlDateTime(appointment.actual_called_at) || baselineStart;
                liveEstimatedEndAt = actualCompleted;
                liveWaitMinutesSnapshot = 0;

                if (actualCompleted.getTime() > runningTime.getTime()) {
                    runningTime = actualCompleted;
                }
            } else if (appointment.queue_status === QUEUE_STATUS.IN_PROGRESS) {
                const actualStarted = parseMysqlDateTime(appointment.actual_started_at) || parseMysqlDateTime(appointment.actual_called_at) || now;
                liveEstimatedStartAt = actualStarted;
                
                const rawEstEnd = new Date(actualStarted.getTime() + consultMinutes * 60000);
                // Clamp estimated end to be at least now since they are still in progress
                liveEstimatedEndAt = rawEstEnd.getTime() > now.getTime() ? rawEstEnd : now;
                liveWaitMinutesSnapshot = 0;

                if (liveEstimatedEndAt.getTime() > runningTime.getTime()) {
                    runningTime = liveEstimatedEndAt;
                }
            } else if (
                appointment.queue_status === QUEUE_STATUS.WAITING
                && appointment.actual_called_at
            ) {
                const actualCalled = parseMysqlDateTime(appointment.actual_called_at) || now;
                const estStart = actualCalled.getTime() > now.getTime() ? actualCalled : now;
                liveEstimatedStartAt = estStart;
                liveEstimatedEndAt = new Date(estStart.getTime() + consultMinutes * 60000);
                liveWaitMinutesSnapshot = 0;

                if (liveEstimatedEndAt.getTime() > runningTime.getTime()) {
                    runningTime = liveEstimatedEndAt;
                }
            } else if (
                appointment.checked_in_at
                && READY_QUEUE_STATUSES.includes(appointment.queue_status)
            ) {
                const estStart = new Date(Math.max(baselineStart.getTime(), runningTime.getTime()));
                liveEstimatedStartAt = estStart;
                liveEstimatedEndAt = new Date(estStart.getTime() + consultMinutes * 60000);
                liveWaitMinutesSnapshot = Math.max(0, diffMinutes(liveEstimatedStartAt, now));

                runningTime = liveEstimatedEndAt;
            }
        }

        updatesByAppointmentId.set(Number(appointment.appointment_id), {
            liveEstimatedStartAt,
            liveEstimatedEndAt,
            liveWaitMinutesSnapshot,
        });
    }

    for (const appointment of appointments) {
        const update = updatesByAppointmentId.get(Number(appointment.appointment_id));
        await execute(
            `UPDATE tbl_appointments
             SET live_estimated_start_at = ?,
                 live_estimated_end_at = ?,
                 live_wait_minutes_snapshot = ?,
                 live_eta_updated_at = NOW(),
                 updated_by = COALESCE(?, updated_by),
                 updated_ip = COALESCE(?, updated_ip)
             WHERE appointment_id = ?`,
            [
                formatDateTimeForSql(update?.liveEstimatedStartAt || null),
                formatDateTimeForSql(update?.liveEstimatedEndAt || null),
                update ? update.liveWaitMinutesSnapshot : null,
                actorUserId,
                actorIp,
                appointment.appointment_id,
            ]
        );
    }

    const nextRuntimeAnchorAt = currentRunningAppointment
        ? (
            parseMysqlDateTime(currentRunningAppointment.actual_started_at)
            || parseMysqlDateTime(currentRunningAppointment.actual_called_at)
            || persistedRuntimeAnchorAt
            || now
        )
        : (
            lastCompletedAt
            || autoCallNextDueAt
            || persistedRuntimeAnchorAt
            || now
        );

    await execute(
        `UPDATE tbl_live_queue_sessions
         SET runtime_anchor_at = COALESCE(?, runtime_anchor_at),
             last_runtime_recalc_at = NOW(),
             queue_revision = COALESCE(queue_revision, 0) + 1,
             updated_by = COALESCE(?, updated_by)
         WHERE fk_branch_id = ?
           AND fk_slot_id = ?
           AND appointment_date = ?`,
        [
            formatDateTimeForSql(nextRuntimeAnchorAt),
            actorUserId,
            slot.branchId,
            slot.slotId,
            slot.appointmentDate,
        ]
    );

    return {
        branchId: slot.branchId,
        slotId: slot.slotId,
        appointmentDate: slot.appointmentDate,
        queueRevision: Number(session?.queue_revision || 0) + 1,
    };
};

const logQueueEvent = async (connection, {
    appointmentId = null,
    branchId,
    slotId,
    appointmentDate,
    tokenNumber = null,
    eventType,
    oldQueueStatus = null,
    newQueueStatus = null,
    meta = null,
    createdBy = null,
}) => {
    const execute = getExecutor(connection);

    await execute(
        `INSERT INTO tbl_appointment_queue_events
         (appointment_id, fk_branch_id, fk_slot_id, appointment_date, token_number, event_type, old_queue_status, new_queue_status, meta_json, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            appointmentId,
            branchId,
            slotId,
            appointmentDate,
            tokenNumber,
            eventType,
            oldQueueStatus,
            newQueueStatus,
            meta ? JSON.stringify(meta) : null,
            createdBy,
        ]
    );
};

const getActiveProtectedWindowAppointmentIds = async (execute, {
    branchId,
    slotId,
    appointmentDate,
}) => {
    const resetEventPlaceholders = PROTECTED_WINDOW_RESET_EVENT_TYPES.map(() => '?').join(', ');
    const rows = await execute(
        `SELECT e.meta_json
         FROM tbl_appointment_queue_events e
         WHERE e.fk_branch_id = ?
           AND e.fk_slot_id = ?
           AND e.appointment_date = ?
           AND e.event_type = 'CHECKED_IN'
           AND e.id > COALESCE((
                SELECT MAX(reset_event.id)
                FROM tbl_appointment_queue_events reset_event
                WHERE reset_event.fk_branch_id = e.fk_branch_id
                  AND reset_event.fk_slot_id = e.fk_slot_id
                  AND reset_event.appointment_date = e.appointment_date
                  AND reset_event.event_type IN (${resetEventPlaceholders})
           ), 0)
         ORDER BY e.id DESC
         LIMIT 1`,
        [branchId, slotId, appointmentDate, ...PROTECTED_WINDOW_RESET_EVENT_TYPES]
    );

    return parseProtectedWindowAppointmentIds(rows[0]?.meta_json || null);
};

const autoSelectAndCallNextReady = async (connection, {
    branchId,
    slotId,
    appointmentDate,
    actorUserId = null,
    actorIp = null,
    eventType = 'TOKEN_CALLED_AUTO_NEXT',
    selectionBasis = 'SCHEDULED_PRESENT_THEN_LONGEST_WAITING_PRESENT_HOLD',
    startImmediately = false,
}) => {
    const execute = getExecutor(connection);

    const sessions = await execute(
        `SELECT id, session_status, current_appointment_id, current_token_number
         FROM tbl_live_queue_sessions
         WHERE fk_branch_id = ?
           AND fk_slot_id = ?
           AND appointment_date = ?
         LIMIT 1
         FOR UPDATE`,
        [branchId, slotId, appointmentDate]
    );

    const session = sessions[0] || null;

    if (!session) {
        throw new AppError('Live queue session not found', 404);
    }

    if (session.session_status === SESSION_STATUS.PAUSED) {
        throw new AppError('Queue is paused. Resume session before calling next patient.', 409);
    }

    const runningAppointments = await execute(
        `SELECT appointment_id
         FROM tbl_appointments
         WHERE fk_branch_id = ?
           AND fk_slot_id = ?
           AND appointment_date = ?
           AND is_active = 1
           AND queue_status = ?
         LIMIT 1
         FOR UPDATE`,
        [branchId, slotId, appointmentDate, QUEUE_STATUS.IN_PROGRESS]
    );

    if (runningAppointments.length > 0) {
        throw new AppError('A consultation is already in progress', 409);
    }

    if (session.current_appointment_id) {
        throw new AppError('A patient has already been called for this queue session', 409);
    }

    const pendingCalledAppointments = await execute(
        `SELECT appointment_id
         FROM tbl_appointments
         WHERE fk_branch_id = ?
           AND fk_slot_id = ?
           AND appointment_date = ?
           AND is_active = 1
           AND queue_status = ?
           AND actual_called_at IS NOT NULL
           AND actual_completed_at IS NULL
         ORDER BY actual_called_at ASC, appointment_id ASC
         LIMIT 1
         FOR UPDATE`,
        [branchId, slotId, appointmentDate, QUEUE_STATUS.WAITING]
    );

    if (pendingCalledAppointments.length > 0) {
        throw new AppError('A called patient is still awaiting consultation', 409);
    }

    const runtimeSnapshot = await getLiveQueueSnapshot({
        branchId,
        slotId,
        appointmentDate,
        connection,
    });
    const nextInLineToken = runtimeSnapshot.next_in_line_token || runtimeSnapshot.next_ready_token || null;
    const nextAppointmentId = Number(nextInLineToken?.appointment_id || 0);

    if (!nextAppointmentId) {
        throw new AppError('No checked-in patient is ready to be called', 409);
    }

    const candidates = await execute(
        `SELECT appointment_id,
                current_token_number,
                original_token_number,
                queue_status,
                planned_start_at,
                checked_in_at,
                live_estimated_start_at,
                created_at
         FROM tbl_appointments
         WHERE appointment_id = ?
           AND fk_branch_id = ?
           AND fk_slot_id = ?
           AND appointment_date = ?
           AND is_active = 1
           AND queue_status IN (${READY_QUEUE_STATUSES.map(() => '?').join(', ')})
           AND checked_in_at IS NOT NULL
           AND actual_called_at IS NULL
           AND actual_completed_at IS NULL
         LIMIT 1
         FOR UPDATE`,
        [nextAppointmentId, branchId, slotId, appointmentDate, ...READY_QUEUE_STATUSES]
    );
    const candidate = candidates[0] || null;

    if (!candidate) {
        throw new AppError('Next patient is no longer ready to be called. Refresh the queue and try again.', 409);
    }

    const runtimeAssignmentMode = runtimeSnapshot.next_runtime_assignment_mode
        || runtimeSnapshot.next_in_line_basis
        || (nextInLineToken?.is_on_hold ? 'HOLD_REASSIGN' : 'SCHEDULED_PRESENT');
    const scheduledDueTokenNumber = runtimeSnapshot.scheduled_due_token?.original_token_number
        || runtimeSnapshot.scheduled_due_token?.current_token_number
        || runtimeSnapshot.scheduled_due_token?.token_number
        || null;

    await execute(
        `UPDATE tbl_live_queue_sessions
         SET session_status = CASE
                WHEN session_status IN ('NOT_STARTED', 'COMPLETED') THEN 'RUNNING'
                ELSE session_status
            END,
            session_started_at = COALESCE(session_started_at, NOW()),
            session_ended_at = NULL,
            current_appointment_id = ?,
            current_token_number = ?,
            auto_call_next_due_at = NULL,
            auto_call_next_reason = NULL,
            updated_by = ?
         WHERE fk_branch_id = ?
           AND fk_slot_id = ?
           AND appointment_date = ?`,
        [
            candidate.appointment_id,
            candidate.current_token_number,
            actorUserId,
            branchId,
            slotId,
            appointmentDate,
        ]
    );

    const nextQueueStatus = startImmediately ? QUEUE_STATUS.IN_PROGRESS : QUEUE_STATUS.WAITING;
    await execute(
        `UPDATE tbl_appointments
         SET queue_status = ?,
             actual_called_at = COALESCE(actual_called_at, NOW()),
             actual_started_at = CASE
                WHEN ? THEN COALESCE(actual_started_at, NOW())
                ELSE actual_started_at
             END,
             last_queue_event_at = NOW(),
             updated_by = ?,
             updated_ip = ?
         WHERE appointment_id = ?`,
        [
            nextQueueStatus,
            startImmediately ? 1 : 0,
            actorUserId,
            actorIp,
            candidate.appointment_id,
        ]
    );

    await logQueueEvent(connection, {
        appointmentId: Number(candidate.appointment_id),
        branchId,
        slotId,
        appointmentDate,
        tokenNumber: Number(candidate.current_token_number),
        eventType,
        oldQueueStatus: candidate.queue_status,
        newQueueStatus: nextQueueStatus,
        createdBy: actorUserId,
        meta: {
            selection_basis: selectionBasis,
            start_immediately: Boolean(startImmediately),
            runtime_assignment_mode: runtimeAssignmentMode,
            scheduled_due_token_number: scheduledDueTokenNumber,
            display_token_number: candidate.original_token_number || candidate.current_token_number,
        },
    });

    return {
        branchId,
        slotId,
        appointmentDate,
        appointmentId: Number(candidate.appointment_id),
        tokenNumber: Number(candidate.current_token_number),
        displayTokenNumber: Number(candidate.original_token_number || candidate.current_token_number),
        assignmentMode: runtimeAssignmentMode,
        scheduledDueTokenNumber,
    };
};

const recalculateQueuePlan = async (connection, {
    branchId,
    slotId,
    appointmentDate,
    actorUserId = null,
    actorIp = null,
}) => {
    const execute = getExecutor(connection);
    const slot = await getSlotQueueContext({ connection, slotId, branchId, appointmentDate });
    const baseStartAt = combineDateAndTime(slot.appointmentDate, slot.slotStartTime);

    if (!baseStartAt) {
        return [];
    }

    const appointments = await execute(
        `SELECT
            a.appointment_id,
            a.token_number,
            a.original_token_number,
            a.current_token_number,
            a.fk_treatment_id,
            a.assigned_visit_type_code,
            a.assigned_slot_duration_minutes,
            t.treatment_name,
            COALESCE(a.assigned_slot_duration_minutes, t.estimated_duration_minutes, s.default_consult_minutes, 15) AS consult_minutes
         FROM tbl_appointments a
         JOIN master_treatments t ON t.id = a.fk_treatment_id
         JOIN master_slots s ON s.id = a.fk_slot_id
         WHERE a.fk_branch_id = ?
           AND a.fk_slot_id = ?
           AND a.appointment_date = ?
           AND a.is_active = 1
           AND a.queue_status IN (${ACTIVE_QUEUE_STATUSES.map(() => '?').join(', ')})
         ORDER BY a.current_token_number ASC, a.created_at ASC
         FOR UPDATE`,
        [branchId, slotId, appointmentDate, ...ACTIVE_QUEUE_STATUSES]
    );

    const updatedAppointments = [];
    const shouldUseFixedPlateTimeline = appointments.length > 0 && appointments.every((appointment) => {
        const visitTypeCode = appointment.assigned_visit_type_code || getVisitTypeCode({
            treatmentId: appointment.fk_treatment_id,
            treatmentName: appointment.treatment_name,
        });
        return supportsTokenPlateVisitType(visitTypeCode);
    });
    const slotTokenPlate = shouldUseFixedPlateTimeline
        ? await buildEffectiveSlotTokenPlate({
            executor: execute,
            branchId,
            slotId,
            appointmentDate,
            slotStartTime: slot.slotStartTime,
        })
        : null;
    let nextPlannedStartAt = baseStartAt;

    for (const appointment of appointments) {
        const currentTokenNumber = Number(appointment.current_token_number) || 1;
        const fixedTokenNumber = Number(appointment.token_number) || Number(appointment.original_token_number) || currentTokenNumber;
        const plateToken = shouldUseFixedPlateTimeline
            ? getPlateTokenByNumber(slotTokenPlate, fixedTokenNumber)
            : null;
        const consultMinutes = resolveConsultMinutes(
            appointment.assigned_slot_duration_minutes ?? plateToken?.duration_minutes ?? appointment.consult_minutes,
            slot.defaultConsultMinutes
        );
        let plannedStartAt = nextPlannedStartAt;
        let plannedEndAt = addMinutes(plannedStartAt, consultMinutes);

        if (plateToken) {
            const [year, month, day] = String(appointmentDate).split('-').map(Number);
            const [startHour, startMinute] = String(plateToken.estimated_start_at).split(':').map(Number);
            plannedStartAt = new Date(year, month - 1, day, startHour, startMinute, 0);
            plannedEndAt = addMinutes(plannedStartAt, consultMinutes);
        }

        await execute(
            `UPDATE tbl_appointments
             SET planned_start_at = ?,
                 planned_end_at = ?,
                 updated_by = COALESCE(?, updated_by),
                 updated_ip = COALESCE(?, updated_ip)
             WHERE appointment_id = ?`,
            [
                formatDateTimeForSql(plannedStartAt),
                formatDateTimeForSql(plannedEndAt),
                actorUserId,
                actorIp,
                appointment.appointment_id,
            ]
        );

        updatedAppointments.push({
            appointment_id: Number(appointment.appointment_id),
            current_token_number: currentTokenNumber,
            fixed_token_number: fixedTokenNumber,
            consult_minutes: consultMinutes,
            planned_start_at: formatDateTimeForSql(plannedStartAt),
            planned_end_at: formatDateTimeForSql(plannedEndAt),
        });

        nextPlannedStartAt = shouldUseFixedPlateTimeline ? nextPlannedStartAt : plannedEndAt;
    }

    await recalculateLiveRuntimeProjection(connection, {
        branchId,
        slotId,
        appointmentDate,
        actorUserId,
        actorIp,
    });

    return updatedAppointments;
};

const getLiveQueueSnapshot = async ({
    branchId = null,
    slotId,
    appointmentDate = null,
    connection = null,
}) => {
    const execute = getExecutor(connection);
    const slot = await getSlotQueueContext({ connection, slotId, branchId, appointmentDate });
    const session = await ensureQueueSession(connection, {
        branchId: slot.branchId,
        slotId: slot.slotId,
        appointmentDate: slot.appointmentDate,
    });

    const activeQueue = await execute(
        `SELECT
            a.appointment_id,
            a.auid,
            a.fk_patient_id,
            ${getAppointmentPatientColumns()},
            a.fk_treatment_id,
            t.treatment_name,
            COALESCE(a.assigned_slot_duration_minutes, t.estimated_duration_minutes, ?, 15) AS consult_minutes,
            a.current_token_number AS token_number,
            a.original_token_number,
            a.queue_status,
            a.status AS appointment_status,
            a.planned_start_at,
            a.planned_end_at,
            a.live_estimated_start_at,
            a.live_estimated_end_at,
            a.live_wait_minutes_snapshot,
            a.live_eta_updated_at,
            a.actual_called_at,
            a.actual_started_at,
            a.actual_completed_at,
            a.last_queue_event_at,
            a.checked_in_at,
            a.arrival_sequence,
            a.live_queue_assigned_position,
            a.live_queue_displacement_count,
            a.live_queue_early_arrival,
            a.is_shifted,
            a.shift_reason,
            a.booked_by_type,
            a.reception_status,
            a.consultation_payment_status,
            a.created_at
         FROM tbl_appointments a
         ${getAppointmentPatientJoin()}
         JOIN master_treatments t ON t.id = a.fk_treatment_id
         WHERE a.fk_branch_id = ?
           AND a.fk_slot_id = ?
           AND a.appointment_date = ?
           AND a.is_active = 1
           AND a.queue_status IN (${ACTIVE_QUEUE_STATUSES.map(() => '?').join(', ')})
         ORDER BY a.current_token_number ASC, a.created_at ASC`,
        [slot.defaultConsultMinutes, slot.branchId, slot.slotId, slot.appointmentDate, ...ACTIVE_QUEUE_STATUSES]
    );

    const timelineRows = await execute(
        `SELECT
            a.appointment_id,
            a.fk_branch_id,
            a.fk_slot_id,
            a.appointment_date,
            a.current_token_number AS token_number,
            a.original_token_number,
            a.current_token_number,
            a.queue_status,
            a.checked_in_at,
            a.arrival_sequence,
            a.live_queue_assigned_position,
            a.live_queue_displacement_count,
            a.live_queue_early_arrival,
            a.actual_called_at,
            a.actual_started_at,
            a.actual_completed_at,
            a.planned_start_at,
            a.live_estimated_start_at,
            a.created_at
         FROM tbl_appointments a
         WHERE a.fk_branch_id = ?
           AND a.fk_slot_id = ?
           AND a.appointment_date = ?
           AND a.is_active = 1
           AND a.status <> 'Cancelled'
         ORDER BY a.current_token_number ASC, a.created_at ASC`,
        [slot.branchId, slot.slotId, slot.appointmentDate]
    );
    const timelineRowsWithBlankSlots = [
        ...timelineRows,
        ...await buildPlateBlankTimelineRows({
            execute,
            branchId: slot.branchId,
            slotId: slot.slotId,
            appointmentDate: slot.appointmentDate,
            slotStartTime: slot.slotStartTime,
            timelineRows,
        }),
    ];
    const completedBefore = countCompletedQueueItems(timelineRows);
    const protectedWindowAppointmentIds = await getActiveProtectedWindowAppointmentIds(execute, {
        branchId: slot.branchId,
        slotId: slot.slotId,
        appointmentDate: slot.appointmentDate,
    });

    const [lastCompleted] = await execute(
        `SELECT appointment_id, current_token_number, planned_end_at, actual_completed_at
         FROM tbl_appointments
         WHERE fk_branch_id = ?
           AND fk_slot_id = ?
           AND appointment_date = ?
           AND queue_status = ?
           AND actual_completed_at IS NOT NULL
         ORDER BY actual_completed_at DESC
         LIMIT 1`,
        [slot.branchId, slot.slotId, slot.appointmentDate, QUEUE_STATUS.COMPLETED]
    );

    const now = new Date();
    const mappedActiveQueue = [];

    const isSessionRunning = session?.session_status === SESSION_STATUS.RUNNING;

    let currentRunningAppointment = isSessionRunning
        ? (activeQueue.find((item) => item.queue_status === QUEUE_STATUS.IN_PROGRESS) || null)
        : null;

    if (!currentRunningAppointment && session?.current_appointment_id) {
        const sessionPinnedAppointment = activeQueue.find(
            (item) => Number(item.appointment_id) === Number(session.current_appointment_id)
        ) || null;

        if (isSessionPinnedRunningAppointment(
            sessionPinnedAppointment,
            session.current_appointment_id,
            session?.session_status || null,
        )) {
            currentRunningAppointment = sessionPinnedAppointment;
        }
    }

    let driftMinutes = 0;

    if (currentRunningAppointment && currentRunningAppointment.actual_started_at && currentRunningAppointment.planned_end_at) {
        const currentStartedAt = parseMysqlDateTime(currentRunningAppointment.actual_started_at);
        const currentPlannedEndAt = parseMysqlDateTime(currentRunningAppointment.planned_end_at);
        const currentEstimatedEndAt = addMinutes(
            currentStartedAt,
            resolveConsultMinutes(currentRunningAppointment.consult_minutes, slot.defaultConsultMinutes)
        );
        const effectiveCurrentEndAt = currentEstimatedEndAt && currentEstimatedEndAt > now ? currentEstimatedEndAt : now;
        driftMinutes = diffMinutes(effectiveCurrentEndAt, currentPlannedEndAt);
    } else if (lastCompleted?.actual_completed_at && lastCompleted?.planned_end_at) {
        driftMinutes = diffMinutes(
            parseMysqlDateTime(lastCompleted.actual_completed_at),
            parseMysqlDateTime(lastCompleted.planned_end_at)
        );
    }

    let previousEstimatedEndAt = null;
    let previousPlannedEndAt = null;
    const slotBaseStartAt = combineDateAndTime(slot.appointmentDate, slot.slotStartTime);

    for (const row of activeQueue) {
        const consultMinutes = resolveConsultMinutes(row.consult_minutes, slot.defaultConsultMinutes);
        const plannedStartAt = parseMysqlDateTime(row.planned_start_at)
            || previousPlannedEndAt
            || slotBaseStartAt;
        const plannedEndAt = parseMysqlDateTime(row.planned_end_at)
            || addMinutes(plannedStartAt, consultMinutes);

        let estimatedStartAt = plannedStartAt;

        if (
            currentRunningAppointment
            && Number(row.appointment_id) === Number(currentRunningAppointment.appointment_id)
            && row.actual_started_at
        ) {
            estimatedStartAt = parseMysqlDateTime(row.actual_started_at) || plannedStartAt;
        } else {
            estimatedStartAt = addMinutes(plannedStartAt, driftMinutes) || plannedStartAt;

            if (previousEstimatedEndAt && estimatedStartAt < previousEstimatedEndAt) {
                estimatedStartAt = previousEstimatedEndAt;
            }
        }

        const estimatedEndAt = addMinutes(estimatedStartAt, consultMinutes);

        if (!previousEstimatedEndAt || estimatedEndAt > previousEstimatedEndAt) {
            previousEstimatedEndAt = estimatedEndAt;
        }
        previousPlannedEndAt = plannedEndAt;

        mappedActiveQueue.push(decorateTokenFields({
            ...row,
            fk_branch_id: slot.branchId,
            fk_slot_id: slot.slotId,
            appointment_date: slot.appointmentDate,
            slot_name: slot.slotName,
            start_time: slot.slotStartTime,
            end_time: slot.slotEndTime,
            token_number: Number(row.token_number),
            original_token_number: row.original_token_number === null ? null : Number(row.original_token_number),
            current_token_number: row.token_number === null ? null : Number(row.token_number),
            arrival_sequence: row.arrival_sequence === null ? null : Number(row.arrival_sequence),
            consult_minutes: consultMinutes,
            estimated_start_at: formatDateTimeForSql(estimatedStartAt),
            estimated_end_at: formatDateTimeForSql(estimatedEndAt),
            estimated_wait_minutes: estimatedStartAt ? Math.max(0, diffMinutes(estimatedStartAt, now)) : null,
            live_estimated_start_at: row.live_estimated_start_at || null,
            live_estimated_end_at: row.live_estimated_end_at || null,
            live_estimated_wait_minutes: row.live_estimated_start_at
                ? Math.max(0, diffMinutes(parseMysqlDateTime(row.live_estimated_start_at), now))
                : null,
            live_eta_updated_at: row.live_eta_updated_at || null,
        }));
    }

    const rawDerivedView = buildDerivedLiveQueueView({
        queueItems: mappedActiveQueue,
        timelineItems: timelineRowsWithBlankSlots,
        currentRunningAppointmentId: currentRunningAppointment?.appointment_id || null,
        sessionStatus: session?.session_status || SESSION_STATUS.NOT_STARTED,
        now,
        protectedWindowAppointmentIds,
    });
    const frozenDisplaySequenceView = buildFrozenDisplaySequenceView({
        queueItems: mappedActiveQueue,
        timelineItems: timelineRowsWithBlankSlots,
        sessionStatus: session?.session_status || SESSION_STATUS.RUNNING,
        now,
        protectedWindowAppointmentIds,
    });
    const derivedView = applyFrozenDisplaySequenceToDerivedView({
        derivedView: rawDerivedView,
        frozenDisplaySequenceView,
    });

    const currentRunning = derivedView.currentRunning || null;

    const pipelineQueue = [
        ...(currentRunning ? [currentRunning] : []),
        ...derivedView.calledQueue,
        ...derivedView.readyQueue,
    ];

    const hasPersistedLiveProjection = derivedView.items.some(
        (item) => item.live_estimated_start_at || item.live_estimated_end_at || item.live_eta_updated_at
    );

    let nextLiveStartAt = currentRunning?.actual_started_at
        ? addMinutes(
            parseMysqlDateTime(currentRunning.actual_started_at),
            resolveConsultMinutes(currentRunning.consult_minutes, slot.defaultConsultMinutes)
        )
        : (parseMysqlDateTime(session?.auto_call_next_due_at) || ((session?.session_status || 'NOT_STARTED') === 'NOT_STARTED' && slotBaseStartAt > now ? slotBaseStartAt : now));

    const readyQueueWithLiveEta = derivedView.readyQueue.map((item) => {
        if (hasPersistedLiveProjection && item.live_estimated_start_at) {
            return {
                ...item,
                live_estimated_wait_minutes: Math.max(0, diffMinutes(parseMysqlDateTime(item.live_estimated_start_at), now)),
            };
        }

        const consultMinutes = resolveConsultMinutes(item.consult_minutes, slot.defaultConsultMinutes);
        const estimatedStartAt = nextLiveStartAt && nextLiveStartAt > now ? nextLiveStartAt : now;
        const estimatedEndAt = addMinutes(estimatedStartAt, consultMinutes);
        nextLiveStartAt = estimatedEndAt;

        return {
            ...item,
            live_estimated_start_at: formatDateTimeForSql(estimatedStartAt),
            live_estimated_end_at: formatDateTimeForSql(estimatedEndAt),
            live_estimated_wait_minutes: estimatedStartAt ? Math.max(0, diffMinutes(estimatedStartAt, now)) : null,
        };
    });

    const readyQueueWithLiveEtaById = new Map(
        readyQueueWithLiveEta.map((item) => [Number(item.appointment_id), item])
    );

    const enrichedActiveQueue = derivedView.items.map((item) => {
        if (readyQueueWithLiveEtaById.has(Number(item.appointment_id))) {
            return readyQueueWithLiveEtaById.get(Number(item.appointment_id));
        }

        if (currentRunning && Number(item.appointment_id) === Number(currentRunning.appointment_id)) {
            if (hasPersistedLiveProjection && (item.live_estimated_start_at || item.live_estimated_end_at)) {
                return {
                    ...item,
                    live_estimated_wait_minutes: 0,
                };
            }

            const consultMinutes = resolveConsultMinutes(item.consult_minutes, slot.defaultConsultMinutes);
            const currentEstimatedEndAt = item.actual_started_at
                ? addMinutes(parseMysqlDateTime(item.actual_started_at), consultMinutes)
                : addMinutes(now, consultMinutes);

            return {
                ...item,
                live_estimated_start_at: item.actual_started_at || formatDateTimeForSql(now),
                live_estimated_end_at: formatDateTimeForSql(currentEstimatedEndAt),
                live_estimated_wait_minutes: 0,
            };
        }

        if (!item.checked_in_at) {
            return {
                ...item,
                live_estimated_start_at: null,
                live_estimated_end_at: null,
                live_estimated_wait_minutes: null,
                live_eta_updated_at: null,
            };
        }

        if (item.live_estimated_start_at || item.live_estimated_end_at || item.live_eta_updated_at) {
            return {
                ...item,
                live_estimated_wait_minutes: item.live_estimated_start_at
                    ? Math.max(0, diffMinutes(parseMysqlDateTime(item.live_estimated_start_at), now))
                    : null,
            };
        }

        return {
            ...item,
            live_estimated_start_at: null,
            live_estimated_end_at: null,
            live_estimated_wait_minutes: null,
        };
    });

    const enrichedActiveQueueById = new Map(
        enrichedActiveQueue.map((item) => [Number(item.appointment_id), item])
    );
    const projectedRuntimeOrderedItems = buildCurrentQueueTimingProjection({
        runtimeOrderedItems: derivedView.runtimeOrderedItems.map(
            (item) => enrichedActiveQueueById.get(Number(item.appointment_id)) || item
        ),
        sessionStatus: session?.session_status || SESSION_STATUS.NOT_STARTED,
        currentRunningAppointmentId: currentRunning?.appointment_id || session?.current_appointment_id || null,
        now,
        defaultConsultMinutes: slot.defaultConsultMinutes,
    });
    const projectedActiveQueueById = new Map(
        projectedRuntimeOrderedItems.map((item) => [Number(item.appointment_id), item])
    );
    const applyProjectedLiveEta = (item) => {
        if (!item) {
            return item;
        }

        const projectedStartAt = item.current_queue_start_at || null;
        const projectedEndAt = item.current_queue_end_at || null;

        if (!projectedStartAt && !projectedEndAt) {
            return item;
        }

        return {
            ...item,
            live_estimated_start_at: projectedStartAt,
            live_estimated_end_at: projectedEndAt,
            live_estimated_wait_minutes: projectedStartAt
                ? Math.max(0, diffMinutes(parseMysqlDateTime(projectedStartAt), now))
                : item.live_estimated_wait_minutes,
        };
    };
    const resolveProjectedItem = (item) => applyProjectedLiveEta(
        projectedActiveQueueById.get(Number(item?.appointment_id))
            || enrichedActiveQueueById.get(Number(item?.appointment_id))
            || item
    );
    const resolveProjectedPositionItem = (item) => decorateSessionQueuePosition(
        resolveProjectedItem(item),
        completedBefore
    );

    const finalCurrentRunning = currentRunning
        ? resolveProjectedPositionItem(currentRunning)
        : null;
    const finalReadyQueue = readyQueueWithLiveEta.map(
        (item) => resolveProjectedPositionItem(item)
    );
    const finalCalledQueue = derivedView.calledQueue.map(
        (item) => resolveProjectedPositionItem(item)
    );
    const finalHoldQueue = derivedView.holdQueue.map(
        (item) => resolveProjectedPositionItem(item)
    );
    const finalNotArrivedQueue = derivedView.notArrivedQueue.map(
        (item) => resolveProjectedPositionItem(item)
    );
    const finalNextRuntimeCandidate = derivedView.nextRuntimeCandidate
        ? resolveProjectedPositionItem(derivedView.nextRuntimeCandidate)
        : null;
    const finalScheduledDueToken = derivedView.scheduledDueToken
        ? resolveProjectedPositionItem(derivedView.scheduledDueToken)
        : null;

    return {
        branch_id: slot.branchId,
        branch_name: slot.branchName,
        slot_id: slot.slotId,
        slot_name: slot.slotName,
        appointment_date: slot.appointmentDate,
        slot_start_time: slot.slotStartTime,
        slot_end_time: slot.slotEndTime,
        default_consult_minutes: slot.defaultConsultMinutes,
        scheduling_basis: 'TREATMENT_ESTIMATED_DURATION_WITH_SLOT_FALLBACK',
        session: serializeQueueDateTimes({
            session_status: session?.session_status || SESSION_STATUS.NOT_STARTED,
            current_appointment_id: session?.current_appointment_id || null,
            current_token_number: session?.current_token_number || currentRunning?.token_number || null,
            current_token_display: formatTokenDisplay(
                session?.current_token_number || currentRunning?.token_number || null,
                { slotName: slot.slotName, startTime: slot.slotStartTime }
            ),
            session_started_at: session?.session_started_at || null,
            session_ended_at: session?.session_ended_at || null,
            runtime_anchor_at: session?.runtime_anchor_at || null,
            last_runtime_recalc_at: session?.last_runtime_recalc_at || null,
            auto_call_next_due_at: session?.auto_call_next_due_at || null,
            auto_call_next_reason: session?.auto_call_next_reason || null,
            queue_revision: Number(session?.queue_revision || 0),
        }),
        queue_management_mode: 'FIXED_DISPLAY_TOKEN_WITH_DYNAMIC_RUNTIME_QUEUE',
        display_token_basis: 'ORIGINAL_TOKEN_NUMBER_WITH_CURRENT_TOKEN_FALLBACK',
        current_running_token: finalCurrentRunning
            ? serializeQueueDateTimes({
                appointment_id: finalCurrentRunning.appointment_id,
                auid: finalCurrentRunning.auid,
                token_number: finalCurrentRunning.token_number,
                token_display: finalCurrentRunning.token_display,
                display_token_number: finalCurrentRunning.display_token_number,
                display_token_display: finalCurrentRunning.display_token_display,
                patient_id: finalCurrentRunning.fk_patient_id,
                patient_full_name: finalCurrentRunning.patient_full_name,
                patient_name: finalCurrentRunning.patient_full_name,
                visiting_patient_full_name: finalCurrentRunning.visiting_patient_full_name,
                primary_patient_full_name: finalCurrentRunning.primary_patient_full_name,
                treatment_name: finalCurrentRunning.treatment_name,
                consult_minutes: finalCurrentRunning.consult_minutes,
                queue_status: finalCurrentRunning.queue_status,
                queue_bucket: finalCurrentRunning.queue_bucket,
                planned_start_at: finalCurrentRunning.planned_start_at,
                planned_end_at: finalCurrentRunning.planned_end_at,
                estimated_start_at: finalCurrentRunning.estimated_start_at,
                actual_called_at: finalCurrentRunning.actual_called_at,
                actual_started_at: finalCurrentRunning.actual_started_at,
                checked_in_at: finalCurrentRunning.checked_in_at,
                live_estimated_start_at: finalCurrentRunning.live_estimated_start_at,
                live_estimated_end_at: finalCurrentRunning.live_estimated_end_at,
                live_estimated_wait_minutes: finalCurrentRunning.live_estimated_wait_minutes,
                live_delay_minutes: finalCurrentRunning.live_delay_minutes,
                live_eta_updated_at: finalCurrentRunning.live_eta_updated_at,
                estimated_end_at: finalCurrentRunning.estimated_end_at,
                is_on_hold: finalCurrentRunning.is_on_hold,
                hold_rank: finalCurrentRunning.hold_rank,
                hold_state: finalCurrentRunning.hold_state,
                present_now: finalCurrentRunning.present_now,
                present_on_time: finalCurrentRunning.present_on_time,
                hold_waiting_minutes: finalCurrentRunning.hold_waiting_minutes,
                hold_priority_reason: finalCurrentRunning.hold_priority_reason,
                runtime_settled_order: finalCurrentRunning.runtime_settled_order,
                runtime_settled_token_number: finalCurrentRunning.runtime_settled_token_number,
                scheduled_due: finalCurrentRunning.scheduled_due,
                runtime_priority_rank: finalCurrentRunning.runtime_priority_rank,
                live_queue_position: finalCurrentRunning.live_queue_position,
                ready_queue_position: finalCurrentRunning.ready_queue_position,
                active_queue_position: finalCurrentRunning.active_queue_position,
                completed_before: finalCurrentRunning.completed_before,
                session_queue_position: finalCurrentRunning.session_queue_position,
                queue_position_basis: finalCurrentRunning.queue_position_basis,
                position_explanation: finalCurrentRunning.position_explanation,
                current_queue_position: finalCurrentRunning.current_queue_position,
                current_queue_duration_minutes: finalCurrentRunning.current_queue_duration_minutes,
                current_queue_start_at: finalCurrentRunning.current_queue_start_at,
                current_queue_end_at: finalCurrentRunning.current_queue_end_at,
                current_queue_time_basis: finalCurrentRunning.current_queue_time_basis,
                current_queue_time_generated_at: finalCurrentRunning.current_queue_time_generated_at,
            })
            : null,
        next_ready_token: serializeQueueDateTimes(finalNextRuntimeCandidate || finalReadyQueue[0] || null),
        next_in_line_token: serializeQueueDateTimes(finalNextRuntimeCandidate || finalReadyQueue[0] || null),
        next_in_line_basis: derivedView.nextRuntimeAssignmentMode || null,
        next_runtime_assignment_mode: derivedView.nextRuntimeAssignmentMode || null,
        scheduled_due_token: serializeQueueDateTimes(finalScheduledDueToken),
        waiting_queue: serializeQueueListDateTimes(projectedRuntimeOrderedItems
            .filter((item) => item.queue_status !== QUEUE_STATUS.IN_PROGRESS)
            .map((item) => resolveProjectedPositionItem(item))),
        ready_queue: serializeQueueListDateTimes(finalReadyQueue),
        called_queue: serializeQueueListDateTimes(finalCalledQueue),
        hold_queue: serializeQueueListDateTimes(finalHoldQueue),
        not_arrived_queue: serializeQueueListDateTimes(finalNotArrivedQueue),
        service_pipeline: serializeQueueListDateTimes(pipelineQueue.map(
            (item) => resolveProjectedPositionItem(item)
        )),
        active_queue: serializeQueueListDateTimes(projectedRuntimeOrderedItems.map((item) => resolveProjectedPositionItem(item))),
        queue_status: session?.session_status || SESSION_STATUS.NOT_STARTED,
        drift_minutes: driftMinutes,
        queue_revision: Number(session?.queue_revision || 0),
        last_runtime_recalc_at: formatDateTimeForApi(session?.last_runtime_recalc_at || null),
        totals: {
            active: enrichedActiveQueue.length,
            booked: enrichedActiveQueue.filter((item) => item.queue_status === QUEUE_STATUS.BOOKED).length,
            checked_in: enrichedActiveQueue.filter((item) => item.queue_status === QUEUE_STATUS.CHECKED_IN).length,
            waiting: enrichedActiveQueue.filter((item) => item.queue_status === QUEUE_STATUS.WAITING).length,
            in_progress: enrichedActiveQueue.filter((item) => item.queue_status === QUEUE_STATUS.IN_PROGRESS).length,
            ready: finalReadyQueue.length,
            called: finalCalledQueue.length,
            hold: finalHoldQueue.length,
            not_arrived: finalNotArrivedQueue.length,
        },
    };
};

const getCurrentDateTokenList = async ({
    branchId = null,
    slotId = null,
    appointmentDate = null,
    connection = null,
}) => {
    const execute = getExecutor(connection);
    const targetDate = appointmentDate && isValidDateString(appointmentDate)
        ? appointmentDate
        : [
            new Date().getFullYear(),
            pad(new Date().getMonth() + 1),
            pad(new Date().getDate()),
        ].join('-');

    const conditions = [
        'a.appointment_date = ?',
        `a.queue_status IN (${ACTIVE_QUEUE_STATUSES.map(() => '?').join(', ')})`,
        'a.is_active = 1',
        `a.status <> 'Cancelled'`,
    ];
    const params = [targetDate];
    params.push(...ACTIVE_QUEUE_STATUSES);

    if (branchId) {
        conditions.push('a.fk_branch_id = ?');
        params.push(branchId);
    }

    if (slotId) {
        conditions.push('a.fk_slot_id = ?');
        params.push(slotId);
    }

    const rows = await execute(
        `SELECT
            a.appointment_id,
            a.auid,
            a.fk_patient_id,
            ${getAppointmentPatientColumns()},
            a.fk_branch_id,
            b.branch_name,
            a.fk_treatment_id,
            t.treatment_name,
            COALESCE(a.assigned_slot_duration_minutes, t.estimated_duration_minutes, s.default_consult_minutes, 15) AS consult_minutes,
            a.fk_slot_id,
            s.slot_name,
            s.start_time,
            s.end_time,
            COALESCE(s.default_consult_minutes, 15) AS default_consult_minutes,
            a.current_token_number AS token_number,
            a.original_token_number,
            a.queue_status,
            a.status AS appointment_status,
            a.reception_status,
            a.consultation_payment_status,
            a.booked_by_type,
            a.is_shifted,
            a.shift_reason,
            a.not_available_at,
            a.checked_in_at,
            a.arrival_sequence,
            a.live_queue_assigned_position,
            a.live_queue_displacement_count,
            a.live_queue_early_arrival,
            a.planned_start_at,
            a.planned_end_at,
            a.live_estimated_start_at,
            a.live_estimated_end_at,
            a.live_wait_minutes_snapshot,
            a.live_eta_updated_at,
            a.actual_called_at,
            a.actual_started_at,
            a.actual_completed_at,
            a.last_queue_event_at,
            a.symptoms,
            a.appointment_date,
            a.created_at
         FROM tbl_appointments a
         ${getAppointmentPatientJoin()}
         JOIN master_clinic_branches b ON b.id = a.fk_branch_id
         JOIN master_treatments t ON t.id = a.fk_treatment_id
         JOIN master_slots s ON s.id = a.fk_slot_id
         WHERE ${conditions.join(' AND ')}
         ORDER BY a.fk_branch_id ASC, a.fk_slot_id ASC, a.current_token_number ASC, a.created_at ASC`,
        params
    );

    const timelineConditions = [
        'a.appointment_date = ?',
        'a.is_active = 1',
        `a.status <> 'Cancelled'`,
    ];
    const timelineParams = [targetDate];

    if (branchId) {
        timelineConditions.push('a.fk_branch_id = ?');
        timelineParams.push(branchId);
    }

    if (slotId) {
        timelineConditions.push('a.fk_slot_id = ?');
        timelineParams.push(slotId);
    }

    const timelineRows = await execute(
        `SELECT
            a.appointment_id,
            a.fk_branch_id,
            a.fk_slot_id,
            a.appointment_date,
            a.current_token_number AS token_number,
            a.original_token_number,
            a.current_token_number,
            a.queue_status,
            a.checked_in_at,
            a.arrival_sequence,
            a.live_queue_assigned_position,
            a.live_queue_displacement_count,
            a.live_queue_early_arrival,
            a.actual_called_at,
            a.actual_started_at,
            a.actual_completed_at,
            a.planned_start_at,
            a.live_estimated_start_at,
            a.created_at
         FROM tbl_appointments a
         WHERE ${timelineConditions.join(' AND ')}
         ORDER BY a.fk_branch_id ASC, a.fk_slot_id ASC, a.current_token_number ASC, a.created_at ASC`,
        timelineParams
    );

    const normalizedRows = rows.map((row) => {
        const isPresent = Boolean(row.checked_in_at);

        return decorateTokenFields({
            ...row,
            appointment_id: Number(row.appointment_id),
            fk_patient_id: Number(row.fk_patient_id),
            fk_branch_id: Number(row.fk_branch_id),
            fk_treatment_id: Number(row.fk_treatment_id),
            fk_slot_id: Number(row.fk_slot_id),
            token_number: row.token_number === null ? null : Number(row.token_number),
            current_token_number: row.token_number === null ? null : Number(row.token_number),
            original_token_number: row.original_token_number === null ? null : Number(row.original_token_number),
            arrival_sequence: row.arrival_sequence === null ? null : Number(row.arrival_sequence),
            consult_minutes: resolveConsultMinutes(row.consult_minutes, row.default_consult_minutes),
            live_estimated_start_at: isPresent ? row.live_estimated_start_at || null : null,
            live_estimated_end_at: isPresent ? row.live_estimated_end_at || null : null,
            live_estimated_wait_minutes: isPresent && row.live_wait_minutes_snapshot !== null
                ? Number(row.live_wait_minutes_snapshot)
                : null,
            live_eta_updated_at: isPresent ? row.live_eta_updated_at || null : null,
        });
    });

    const sessionRows = await execute(
        `SELECT
            fk_branch_id,
            fk_slot_id,
            appointment_date,
            session_status,
            current_appointment_id
         FROM tbl_live_queue_sessions
         WHERE appointment_date = ?
           ${branchId ? 'AND fk_branch_id = ?' : ''}
           ${slotId ? 'AND fk_slot_id = ?' : ''}`,
        [
            targetDate,
            ...(branchId ? [branchId] : []),
            ...(slotId ? [slotId] : []),
        ]
    );

    const sessionByGroupKey = new Map(
        sessionRows.map((row) => [
            `${Number(row.fk_branch_id)}:${Number(row.fk_slot_id)}:${normalizeAppointmentDateKey(row.appointment_date)}`,
            row,
        ])
    );

    const queueItemsByGroup = normalizedRows.reduce((acc, row) => {
        const key = `${row.fk_branch_id}:${row.fk_slot_id}:${normalizeAppointmentDateKey(row.appointment_date)}`;
        if (!acc.has(key)) {
            acc.set(key, []);
        }

        acc.get(key).push(row);
        return acc;
    }, new Map());
    const timelineRowsByGroup = timelineRows.reduce((acc, row) => {
        const key = `${Number(row.fk_branch_id)}:${Number(row.fk_slot_id)}:${normalizeAppointmentDateKey(row.appointment_date)}`;
        if (!acc.has(key)) {
            acc.set(key, []);
        }

        acc.get(key).push(row);
        return acc;
    }, new Map());

    const decoratedRows = [];
    const nextInLineByGroup = new Map();
    for (const [groupKey, queueItems] of queueItemsByGroup.entries()) {
        const session = sessionByGroupKey.get(groupKey) || null;
        const now = new Date();
        const groupTimelineRows = timelineRowsByGroup.get(groupKey) || queueItems;
        const completedBefore = countCompletedQueueItems(groupTimelineRows);
        const groupTimelineWithBlankSlots = [
            ...groupTimelineRows,
            ...await buildPlateBlankTimelineRows({
                execute,
                branchId: Number(queueItems[0]?.fk_branch_id),
                slotId: Number(queueItems[0]?.fk_slot_id),
                appointmentDate: normalizeAppointmentDateKey(queueItems[0]?.appointment_date),
                slotStartTime: queueItems[0]?.start_time,
                timelineRows: groupTimelineRows,
            }),
        ];
        const protectedWindowAppointmentIds = await getActiveProtectedWindowAppointmentIds(execute, {
            branchId: Number(queueItems[0]?.fk_branch_id),
            slotId: Number(queueItems[0]?.fk_slot_id),
            appointmentDate: normalizeAppointmentDateKey(queueItems[0]?.appointment_date),
        });
        const derivedTokenView = buildDerivedLiveQueueView({
            queueItems,
            timelineItems: groupTimelineWithBlankSlots,
            currentRunningAppointmentId: session?.current_appointment_id || null,
            sessionStatus: session?.session_status || SESSION_STATUS.NOT_STARTED,
            now,
            protectedWindowAppointmentIds,
        });
        const projectedGroupRows = buildCurrentQueueTimingProjection({
            runtimeOrderedItems: derivedTokenView.runtimeOrderedItems,
            sessionStatus: session?.session_status || SESSION_STATUS.NOT_STARTED,
            currentRunningAppointmentId: session?.current_appointment_id || null,
            now,
            defaultConsultMinutes: Number(queueItems[0]?.default_consult_minutes) || 15,
        }).map((item) => {
            const projectedStartAt = item.current_queue_start_at || null;
            const projectedEndAt = item.current_queue_end_at || null;

            if (!projectedStartAt && !projectedEndAt) {
                return item;
            }

            return {
                ...item,
                live_estimated_start_at: projectedStartAt,
                live_estimated_end_at: projectedEndAt,
                live_estimated_wait_minutes: projectedStartAt
                    ? Math.max(0, diffMinutes(parseMysqlDateTime(projectedStartAt), now))
                    : item.live_estimated_wait_minutes,
            };
        }).map((item) => decorateSessionQueuePosition(item, completedBefore));
        const projectedGroupRowsById = new Map(
            projectedGroupRows.map((item) => [Number(item.appointment_id), item])
        );
        const nextInLineToken = derivedTokenView.nextRuntimeCandidate
            ? projectedGroupRowsById.get(Number(derivedTokenView.nextRuntimeCandidate.appointment_id))
                || derivedTokenView.nextRuntimeCandidate
            : null;

        nextInLineByGroup.set(groupKey, {
            next_in_line_token: serializeQueueDateTimes(nextInLineToken),
            next_in_line_basis: derivedTokenView.nextRuntimeAssignmentMode || null,
        });

        decoratedRows.push(...serializeQueueListDateTimes(projectedGroupRows));
    }

    const grouped = decoratedRows.reduce((acc, row) => {
        const key = `${row.fk_branch_id}:${row.fk_slot_id}`;
        const groupKey = `${row.fk_branch_id}:${row.fk_slot_id}:${normalizeAppointmentDateKey(row.appointment_date)}`;
        const nextInLine = nextInLineByGroup.get(groupKey) || {};
        if (!acc[key]) {
            acc[key] = {
                branch_id: Number(row.fk_branch_id),
                branch_name: row.branch_name,
                slot_id: Number(row.fk_slot_id),
                slot_name: row.slot_name,
                start_time: row.start_time,
                end_time: row.end_time,
                default_consult_minutes: Number(row.default_consult_minutes) || 15,
                scheduling_basis: 'TREATMENT_ESTIMATED_DURATION_WITH_SLOT_FALLBACK',
                appointment_date: row.appointment_date,
                next_in_line_token: nextInLine.next_in_line_token || null,
                next_in_line_basis: nextInLine.next_in_line_basis || null,
                tokens: [],
            };
        }
        acc[key].tokens.push(row);
        return acc;
    }, {});

    const currentRunningToken = decoratedRows.find((item) => item.queue_bucket === 'IN_PROGRESS') || null;
    const readyQueue = decoratedRows.filter((item) => item.queue_bucket === 'READY' && !item.is_on_hold);
    const calledQueue = decoratedRows.filter((item) => item.queue_bucket === 'CALLED' && !item.is_on_hold);
    const holdQueue = decoratedRows.filter((item) => item.is_on_hold);
    const notArrivedQueue = decoratedRows.filter((item) => item.queue_bucket === 'NOT_ARRIVED' && !item.is_on_hold);
    const inProgressCount = decoratedRows.filter((item) => item.queue_bucket === 'IN_PROGRESS').length;
    const topLevelNextInLine = Array.from(nextInLineByGroup.values())
        .map((item) => item.next_in_line_token)
        .filter(Boolean)
        .sort((left, right) => {
            const leftStart = normalizeDateOrderValue(
                left.current_queue_start_at || left.live_estimated_start_at || left.planned_start_at
            );
            const rightStart = normalizeDateOrderValue(
                right.current_queue_start_at || right.live_estimated_start_at || right.planned_start_at
            );

            if (leftStart !== rightStart) {
                return leftStart - rightStart;
            }

            return compareTokenNumbers(left, right);
        })[0] || null;

    return {
        appointment_date: targetDate,
        total_tokens: decoratedRows.length,
        groups: Object.values(grouped),
        current_running_token: serializeQueueDateTimes(currentRunningToken),
        next_in_line_token: serializeQueueDateTimes(topLevelNextInLine),
        ready_queue: serializeQueueListDateTimes(readyQueue),
        called_queue: serializeQueueListDateTimes(calledQueue),
        hold_queue: serializeQueueListDateTimes(holdQueue),
        not_arrived_queue: serializeQueueListDateTimes(notArrivedQueue),
        totals: {
            ready: readyQueue.length,
            called: calledQueue.length,
            hold: holdQueue.length,
            not_arrived: notArrivedQueue.length,
            in_progress: inProgressCount,
        },
        tokens: serializeQueueListDateTimes(decoratedRows),
    };
};

const emitLiveQueueEvent = async ({
    branchId,
    slotId,
    appointmentDate,
    eventName,
    reason = null,
    appointmentId = null,
    extra = null,
}) => {
    const snapshot = await getLiveQueueSnapshot({ branchId, slotId, appointmentDate });
    const room = buildLiveQueueRoom({ branchId, slotId, appointmentDate });
    const branchDateRoom = buildLiveQueueDateRoom({ branchId, appointmentDate });
    const globalDateRoom = buildLiveQueueDateRoom({ appointmentDate });
    const payload = {
        event: eventName,
        reason,
        appointment_id: appointmentId,
        generated_at: new Date().toISOString(),
        ...snapshot,
        ...(extra ? { extra } : {}),
    };

    emitToLiveQueueRoom(room, eventName, payload);
    emitToLiveQueueRoom(branchDateRoom, eventName, payload);
    emitToLiveQueueRoom(globalDateRoom, eventName, payload);

    if (eventName !== 'queue-updated') {
        emitToLiveQueueRoom(room, 'queue-updated', payload);
        emitToLiveQueueRoom(branchDateRoom, 'queue-updated', payload);
        emitToLiveQueueRoom(globalDateRoom, 'queue-updated', payload);
    }

    return payload;
};

const getNextArrivalSequenceForQueue = async (execute, {
    branchId,
    slotId,
    appointmentDate,
}) => {
    const rows = await execute(
        `SELECT arrival_sequence
         FROM tbl_appointments
         WHERE fk_branch_id = ?
           AND fk_slot_id = ?
           AND appointment_date = ?
           AND arrival_sequence IS NOT NULL
         ORDER BY arrival_sequence DESC
         LIMIT 1
         FOR UPDATE`,
        [branchId, slotId, appointmentDate]
    );

    return Number(rows[0]?.arrival_sequence || 0) + 1;
};

const markAppointmentQueueCompleted = async (connection, {
    appointmentId,
    actorUserId = null,
    actorIp = null,
    eventType = 'CONSULTATION_COMPLETED',
}) => {
    const execute = getExecutor(connection);

    const appointments = await execute(
        `SELECT appointment_id, fk_branch_id, fk_slot_id, appointment_date, current_token_number,
                queue_status, checked_in_at, arrival_sequence
         FROM tbl_appointments
         WHERE appointment_id = ?
         LIMIT 1
         FOR UPDATE`,
        [appointmentId]
    );

    if (appointments.length === 0) {
        throw new AppError('Appointment not found', 404);
    }

    const appointment = appointments[0];
    const nextArrivalSequence = appointment.checked_in_at
        ? null
        : await getNextArrivalSequenceForQueue(execute, {
            branchId: Number(appointment.fk_branch_id),
            slotId: Number(appointment.fk_slot_id),
            appointmentDate: appointment.appointment_date,
        });
    const sessions = await execute(
        `SELECT id, session_status, current_appointment_id, current_token_number
         FROM tbl_live_queue_sessions
         WHERE fk_branch_id = ?
           AND fk_slot_id = ?
           AND appointment_date = ?
         LIMIT 1
         FOR UPDATE`,
        [
            appointment.fk_branch_id,
            appointment.fk_slot_id,
            appointment.appointment_date,
        ]
    );
    const session = sessions[0] || null;
    const completedCurrentAppointment = Boolean(
        session?.current_appointment_id
        && Number(session.current_appointment_id) === Number(appointmentId)
    );

    await execute(
        `UPDATE tbl_appointments
         SET queue_status = ?,
             checked_in_at = COALESCE(checked_in_at, NOW()),
             arrival_sequence = COALESCE(arrival_sequence, ?),
             actual_started_at = COALESCE(actual_started_at, NOW()),
             actual_completed_at = NOW(),
             last_queue_event_at = NOW(),
             updated_by = COALESCE(?, updated_by),
             updated_ip = COALESCE(?, updated_ip)
         WHERE appointment_id = ?`,
        [QUEUE_STATUS.COMPLETED, nextArrivalSequence, actorUserId, actorIp, appointmentId]
    );

    const remainingActiveRows = await execute(
        `SELECT appointment_id
         FROM tbl_appointments
         WHERE fk_branch_id = ?
           AND fk_slot_id = ?
           AND appointment_date = ?
           AND is_active = 1
           AND queue_status IN (${ACTIVE_QUEUE_STATUSES.map(() => '?').join(', ')})
         LIMIT 1`,
        [
            appointment.fk_branch_id,
            appointment.fk_slot_id,
            appointment.appointment_date,
            ...ACTIVE_QUEUE_STATUSES,
        ]
    );

    const pendingCalledRows = await execute(
        `SELECT appointment_id, current_token_number
         FROM tbl_appointments
         WHERE fk_branch_id = ?
           AND fk_slot_id = ?
           AND appointment_date = ?
           AND is_active = 1
           AND queue_status = ?
           AND actual_called_at IS NOT NULL
           AND actual_completed_at IS NULL
         ORDER BY actual_called_at ASC, appointment_id ASC
         LIMIT 1
         FOR UPDATE`,
        [
            appointment.fk_branch_id,
            appointment.fk_slot_id,
            appointment.appointment_date,
            QUEUE_STATUS.WAITING,
        ]
    );
    const pendingCalledAppointment = pendingCalledRows[0] || null;

    if (session && remainingActiveRows.length === 0) {
        await execute(
            `UPDATE tbl_live_queue_sessions
             SET current_appointment_id = NULL,
                 current_token_number = NULL,
                 auto_call_next_due_at = NULL,
                 auto_call_next_reason = NULL,
                 session_status = CASE
                     WHEN session_status <> 'COMPLETED' THEN 'COMPLETED'
                     ELSE session_status
                 END,
                 session_ended_at = CASE
                     WHEN session_status <> 'COMPLETED' THEN NOW()
                     ELSE session_ended_at
                 END,
                 updated_by = COALESCE(?, updated_by)
             WHERE id = ?`,
            [actorUserId, session.id]
        );
    } else if (session && completedCurrentAppointment) {
        await execute(
            `UPDATE tbl_live_queue_sessions
             SET current_appointment_id = ?,
                 current_token_number = ?,
                 auto_call_next_due_at = NULL,
                 auto_call_next_reason = NULL,
                 updated_by = COALESCE(?, updated_by)
             WHERE id = ?`,
            [
                pendingCalledAppointment?.appointment_id || null,
                pendingCalledAppointment?.current_token_number || null,
                actorUserId,
                session.id,
            ]
        );
    } else if (session && !session.current_appointment_id && pendingCalledAppointment) {
        await execute(
            `UPDATE tbl_live_queue_sessions
             SET current_appointment_id = ?,
                 current_token_number = ?,
                 auto_call_next_due_at = NULL,
                 auto_call_next_reason = NULL,
                 updated_by = COALESCE(?, updated_by)
             WHERE id = ?`,
            [
                pendingCalledAppointment.appointment_id,
                pendingCalledAppointment.current_token_number,
                actorUserId,
                session.id,
            ]
        );
    }

    await logQueueEvent(connection, {
        appointmentId,
        branchId: Number(appointment.fk_branch_id),
        slotId: Number(appointment.fk_slot_id),
        appointmentDate: appointment.appointment_date,
        tokenNumber: Number(appointment.current_token_number),
        eventType,
        oldQueueStatus: appointment.queue_status,
        newQueueStatus: QUEUE_STATUS.COMPLETED,
        createdBy: actorUserId,
    });

    return {
        branchId: Number(appointment.fk_branch_id),
        slotId: Number(appointment.fk_slot_id),
        appointmentDate: appointment.appointment_date,
        tokenNumber: Number(appointment.current_token_number),
        hasRemainingQueue: remainingActiveRows.length > 0,
        completedCurrentAppointment,
        pendingCalledAppointmentId: pendingCalledAppointment
            ? Number(pendingCalledAppointment.appointment_id)
            : null,
        shouldAutoCallNext: Boolean(
            session
            && remainingActiveRows.length > 0
            && !pendingCalledAppointment
            && (
                completedCurrentAppointment
                || !session.current_appointment_id
            )
        ),
    };
};

module.exports = {
    QUEUE_STATUS,
    ACTIVE_QUEUE_STATUSES,
    PRESENT_QUEUE_STATUSES,
    READY_QUEUE_STATUSES,
    SESSION_STATUS,
    isValidDateString,
    toPositiveInt,
    parseMysqlDateTime,
    formatDateTimeForSql,
    addMinutes,
    diffMinutes,
    combineDateAndTime,
    resolveConsultMinutes,
    resolveSlotBlockCode,
    buildLiveQueueRoom,
    buildLiveQueueDateRoom,
    listTodayLiveQueueSessionsForBroadcast,
    listBranchSlotBlockContexts,
    getSlotQueueContext,
    ensureQueueSession,
    logQueueEvent,
    recalculateQueuePlan,
    recalculateLiveRuntimeProjection,
    getLiveQueueSnapshot,
    getCurrentDateTokenList,
    emitLiveQueueEvent,
    emitDoctorSessionUpdateToLiveQueue,
    markAppointmentQueueCompleted,
    buildDerivedLiveQueueView,
    buildFrozenDisplaySequenceView,
    applyFrozenDisplaySequenceToDerivedView,
    buildPlateBlankTimelineRows,
    sortAppointmentsByRuntimeQueue,
    sortReadyCandidatesByFrozenQueueSequence,
    resolveBoundedEarlyArrivalAssignments,
    getActiveProtectedWindowAppointmentIds,
    autoSelectAndCallNextReady,
    applyProtectedVisibleQueueWindow,
};
