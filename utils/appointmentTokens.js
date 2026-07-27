const AppError = require('./AppError');
const { VISIT_TYPE } = require('../services/followupService');

const MAX_TOKEN_NUMBER = 40;
const BRANCH_TWO_ID = 2;
const TOKEN_PLATE_VISIT_TYPE_RULES = {
    [VISIT_TYPE.ACUTE_TREATMENT]: {
        count: 6,
        total_duration_minutes: 12,
        label: 'Acute Treatment',
        short_label: 'Acute',
        color_code: '#F97316',
    },
    [VISIT_TYPE.FIRST_CONSULTATION]: {
        count: 7,
        total_duration_minutes: 70,
        label: 'First Consultation',
        short_label: 'First',
        color_code: '#2563EB',
    },
    [VISIT_TYPE.CHRONIC_CASE_DISCUSSION]: {
        count: 1,
        total_duration_minutes: 14,
        label: 'Chronic Case Discussion',
        short_label: 'Chronic',
        color_code: '#7C3AED',
    },
    [VISIT_TYPE.FOLLOW_UP_VISIT]: {
        count: 26,
        total_duration_minutes: 113,
        label: 'Follow-up Visit',
        short_label: 'Follow-up',
        color_code: '#16A34A',
    },
};
const BRANCH_TWO_TOKEN_PLATE_VISIT_TYPE_RULES = {
    [VISIT_TYPE.ACUTE_TREATMENT]: {
        ...TOKEN_PLATE_VISIT_TYPE_RULES[VISIT_TYPE.ACUTE_TREATMENT],
        count: 8,
        total_duration_minutes: 16,
    },
    [VISIT_TYPE.FIRST_CONSULTATION]: {
        ...TOKEN_PLATE_VISIT_TYPE_RULES[VISIT_TYPE.FIRST_CONSULTATION],
        count: 13,
        total_duration_minutes: 130,
    },
    [VISIT_TYPE.FOLLOW_UP_VISIT]: {
        ...TOKEN_PLATE_VISIT_TYPE_RULES[VISIT_TYPE.FOLLOW_UP_VISIT],
        count: 49,
        total_duration_minutes: 214,
    },
};
const TOKEN_PLATE_VISIT_TYPE_ORDER = [
    VISIT_TYPE.ACUTE_TREATMENT,
    VISIT_TYPE.FIRST_CONSULTATION,
    VISIT_TYPE.CHRONIC_CASE_DISCUSSION,
    VISIT_TYPE.FOLLOW_UP_VISIT,
];

const supportsTokenPlateVisitType = (visitTypeCode) => Boolean(TOKEN_PLATE_VISIT_TYPE_RULES[visitTypeCode]);

const getBranchTokenPlateRules = (branchId) => (
    Number(branchId) === BRANCH_TWO_ID
        ? BRANCH_TWO_TOKEN_PLATE_VISIT_TYPE_RULES
        : TOKEN_PLATE_VISIT_TYPE_RULES
);

const getBranchMaxTokenNumber = (branchId) => Object.values(getBranchTokenPlateRules(branchId))
    .reduce((total, rule) => total + Number(rule.count || 0), 0);

const getLayoutVisitTypeCode = (item) => (
    typeof item === 'string'
        ? item
        : String(item?.visit_type_code || '')
);

const normalizeLayoutEntry = (item) => {
    const visitTypeCode = getLayoutVisitTypeCode(item);
    const durationMinutes = Number(item?.duration_minutes);

    return {
        visit_type_code: visitTypeCode,
        duration_minutes: durationMinutes > 0 ? durationMinutes : null,
    };
};

const isValidTokenPlateLayout = (layout = [], branchId = null) => {
    const rules = getBranchTokenPlateRules(branchId);
    if (!Array.isArray(layout) || layout.length !== getBranchMaxTokenNumber(branchId)) {
        return false;
    }

    const counts = layout.reduce((accumulator, item) => {
        const visitTypeCode = getLayoutVisitTypeCode(item);
        accumulator[visitTypeCode] = (accumulator[visitTypeCode] || 0) + 1;
        return accumulator;
    }, {});

    return TOKEN_PLATE_VISIT_TYPE_ORDER.every((visitTypeCode) => (
        (counts[visitTypeCode] || 0) === (rules[visitTypeCode]?.count || 0)
    ));
};

const getVisitTypeTokenDuration = (rule, occurrenceIndex) => {
    if (Number(rule.duration_minutes) > 0) {
        return Number(rule.duration_minutes);
    }

    const baseDuration = Math.floor(rule.total_duration_minutes / rule.count);
    const longerTokenCount = rule.total_duration_minutes % rule.count;
    return baseDuration + (occurrenceIndex < longerTokenCount ? 1 : 0);
};

const normalizeSeed = (seedValue) => {
    let hash = 2166136261;
    const text = String(seedValue || '');

    for (let index = 0; index < text.length; index += 1) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }

    return hash >>> 0;
};

const createSeededRandom = (seedValue) => {
    let state = normalizeSeed(seedValue) || 1;

    return () => {
        state = (state + 0x6D2B79F5) >>> 0;
        let t = Math.imul(state ^ (state >>> 15), state | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
};

const shuffleDeterministically = (items, seedValue) => {
    const shuffled = [...items];
    const random = createSeededRandom(seedValue);

    for (let index = shuffled.length - 1; index > 0; index -= 1) {
        const randomIndex = Math.floor(random() * (index + 1));
        [shuffled[index], shuffled[randomIndex]] = [shuffled[randomIndex], shuffled[index]];
    }

    return shuffled;
};

const parseTimeToMinutes = (timeValue) => {
    const match = String(timeValue || '').trim().match(/^(\d{2}):(\d{2})(?::(\d{2}))?$/);
    if (!match) {
        return null;
    }

    return (Number(match[1]) * 60) + Number(match[2]);
};

const formatMinutesToTime = (totalMinutes) => {
    const normalizedSeconds = Math.max(0, Math.round((Number(totalMinutes) || 0) * 60));
    const hours = Math.floor(normalizedSeconds / 3600) % 24;
    const minutes = Math.floor((normalizedSeconds % 3600) / 60);
    const seconds = normalizedSeconds % 60;
    const time = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;

    return seconds > 0 ? `${time}:${String(seconds).padStart(2, '0')}` : time;
};

const branchLayoutsCache = {};

const loadBranchLayoutsIntoCache = async () => {
    try {
        const { query } = require('../config/db');
        const rows = await query(
            `SELECT fk_branch_id, token_number, visit_type_code, duration_minutes 
             FROM tbl_branch_token_layouts 
             ORDER BY fk_branch_id, token_number ASC`
        );
        
        const newCache = {};
        rows.forEach((row) => {
            const branchId = Number(row.fk_branch_id);
            if (!newCache[branchId]) {
                newCache[branchId] = [];
            }
            newCache[branchId][row.token_number - 1] = {
                visit_type_code: row.visit_type_code,
                duration_minutes: Number(row.duration_minutes) > 0 ? Number(row.duration_minutes) : null,
            };
        });

        Object.keys(branchLayoutsCache).forEach((branchId) => {
            delete branchLayoutsCache[branchId];
        });

        Object.keys(newCache).forEach((branchId) => {
            const layout = newCache[branchId];
            if (!layout.includes(undefined) && isValidTokenPlateLayout(layout, branchId)) {
                branchLayoutsCache[branchId] = layout;
            }
        });
        console.log('Token layouts loaded into cache for branches:', Object.keys(branchLayoutsCache));
    } catch (error) {
        console.error('Failed to load branch token layouts into cache:', error);
    }
};

const buildRandomizedPlateLayout = ({ branchId, slotId, appointmentDate }) => {
    const cachedLayout = branchLayoutsCache[Number(branchId)];
    if (isValidTokenPlateLayout(cachedLayout, branchId)) {
        return cachedLayout;
    }

    const baseVisitTypes = [];
    const rules = getBranchTokenPlateRules(branchId);

    TOKEN_PLATE_VISIT_TYPE_ORDER.forEach((visitTypeCode) => {
        const count = rules[visitTypeCode]?.count || 0;
        for (let index = 0; index < count; index += 1) {
            baseVisitTypes.push({
                visit_type_code: visitTypeCode,
                duration_minutes: null,
            });
        }
    });

    return shuffleDeterministically(
        baseVisitTypes,
        `${branchId}:branch-token-layout-v2`
    );
};

const buildSlotTokenPlate = ({
    branchId,
    slotId,
    appointmentDate,
    slotStartTime,
    bookedTokenNumbers = new Set(),
    selectedVisitTypeCode = null,
    delayMinutes = 0,
}) => {
    const randomizedLayout = buildRandomizedPlateLayout({
        branchId,
        slotId,
        appointmentDate,
    });
    const slotStartMinutes = parseTimeToMinutes(slotStartTime) || 0;
    let cumulativeMinutes = 0;
    const visitTypeOccurrences = {};

    return randomizedLayout.map((layoutItem, index) => {
        const layoutEntry = normalizeLayoutEntry(layoutItem);
        const visitTypeCode = layoutEntry.visit_type_code;
        const rule = getBranchTokenPlateRules(branchId)[visitTypeCode] || TOKEN_PLATE_VISIT_TYPE_RULES[visitTypeCode];
        const occurrenceIndex = visitTypeOccurrences[visitTypeCode] || 0;
        const durationMinutes = layoutEntry.duration_minutes || getVisitTypeTokenDuration(rule, occurrenceIndex);
        visitTypeOccurrences[visitTypeCode] = occurrenceIndex + 1;
        const tokenNumber = index + 1;
        const estimatedStartAtMinutes = slotStartMinutes + cumulativeMinutes + delayMinutes;
        const estimatedEndAtMinutes = estimatedStartAtMinutes + durationMinutes;
        const isBooked = bookedTokenNumbers.has(tokenNumber);
        const isTypeMatch = !selectedVisitTypeCode || selectedVisitTypeCode === visitTypeCode;
        let selectionDisabledReason = null;

        if (isBooked) {
            selectionDisabledReason = 'Already booked';
        } else if (!isTypeMatch) {
            selectionDisabledReason = `Reserved for ${rule.label}`;
        }

        cumulativeMinutes += durationMinutes;

        return {
            token_number: tokenNumber,
            visit_type_code: visitTypeCode,
            visit_type_label: rule.label,
            short_label: rule.short_label,
            duration_minutes: durationMinutes,
            estimated_start_at: formatMinutesToTime(estimatedStartAtMinutes),
            estimated_end_at: formatMinutesToTime(estimatedEndAtMinutes),
            color_code: rule.color_code,
            is_booked: isBooked,
            is_selectable: !isBooked && isTypeMatch,
            selection_disabled_reason: selectionDisabledReason,
        };
    });
};

const getPlateTokenByNumber = (slotTokenPlate = [], tokenNumber = null) => (
    (slotTokenPlate || []).find((item) => Number(item.token_number) === Number(tokenNumber)) || null
);

const getRequestedPlateToken = ({ requestedTokenNumber, slotTokenPlate, visitTypeCode }) => {
    if (requestedTokenNumber === null || !slotTokenPlate || !visitTypeCode) {
        return null;
    }

    const token = getPlateTokenByNumber(slotTokenPlate, requestedTokenNumber);
    if (!token) {
        throw new AppError('Requested token_number is outside the configured token plate', 400);
    }

    if (token.visit_type_code !== visitTypeCode) {
        throw new AppError(
            `Requested token_number is reserved for ${token.visit_type_label}`,
            409
        );
    }

    return token;
};

const getFirstAvailablePlateTokenNumber = ({
    slotTokenPlate,
    visitTypeCode,
    bookedFixedTokenNumbers,
}) => {
    const matchingRule = TOKEN_PLATE_VISIT_TYPE_RULES[visitTypeCode];
    const availableToken = (slotTokenPlate || []).find((token) =>
        token.visit_type_code === visitTypeCode
        && !bookedFixedTokenNumbers.has(Number(token.token_number))
    );

    if (!availableToken) {
        throw new AppError(
            `No ${matchingRule?.label || 'matching'} token is available for the selected branch, slot and date`,
            409
        );
    }

    return Number(availableToken.token_number);
};

const getNextAvailableTokenNumber = (bookedTokenNumbers, maxTokenNumber = MAX_TOKEN_NUMBER) => {
    for (let token = 1; token <= Number(maxTokenNumber || MAX_TOKEN_NUMBER); token += 1) {
        if (!bookedTokenNumbers.has(token)) {
            return token;
        }
    }

    throw new AppError('No token is available for the selected branch, slot and date', 409);
};

const getAssignedFixedTokenNumber = (requestedTokenNumber, bookedFixedTokenNumbers, maxTokenNumber = MAX_TOKEN_NUMBER) => {
    if (requestedTokenNumber !== null) {
        if (requestedTokenNumber > maxTokenNumber) {
            throw new AppError('Requested token_number is outside the configured token plate', 400);
        }

        if (bookedFixedTokenNumbers.has(requestedTokenNumber)) {
            throw new AppError(
                'Requested token_number is already booked for the selected branch, slot and date',
                409
            );
        }

        return requestedTokenNumber;
    }

    return getNextAvailableTokenNumber(bookedFixedTokenNumbers, maxTokenNumber);
};

const getAssignedCurrentTokenNumber = (requestedTokenNumber, bookedCurrentTokenNumbers, maxTokenNumber = MAX_TOKEN_NUMBER) => {
    if (requestedTokenNumber !== null) {
        if (requestedTokenNumber > maxTokenNumber) {
            throw new AppError('Requested token_number is outside the configured token plate', 400);
        }

        if (bookedCurrentTokenNumbers.has(requestedTokenNumber)) {
            throw new AppError(
                'Requested token_number is already booked for the selected branch, slot and date',
                409
            );
        }

        return requestedTokenNumber;
    }

    return getNextAvailableTokenNumber(bookedCurrentTokenNumbers, maxTokenNumber);
};

const assignAppointmentTokenNumbers = ({
    requestedTokenNumber = null,
    bookedFixedTokenNumbers,
    bookedCurrentTokenNumbers,
    visitTypeCode = null,
    slotTokenPlate = null,
}) => {
    const maxTokenNumber = slotTokenPlate?.length || MAX_TOKEN_NUMBER;
    if (visitTypeCode && slotTokenPlate && supportsTokenPlateVisitType(visitTypeCode)) {
        const requestedPlateToken = getRequestedPlateToken({
            requestedTokenNumber,
            slotTokenPlate,
            visitTypeCode,
        });
        const resolvedTokenNumber = requestedPlateToken
            ? Number(requestedPlateToken.token_number)
            : getFirstAvailablePlateTokenNumber({
                slotTokenPlate,
                visitTypeCode,
                bookedFixedTokenNumbers,
            });

        if (bookedFixedTokenNumbers.has(resolvedTokenNumber)) {
            throw new AppError(
                'Requested token_number is already booked for the selected branch, slot and date',
                409
            );
        }

        const currentTokenNumber = bookedCurrentTokenNumbers.has(resolvedTokenNumber)
            ? getNextAvailableTokenNumber(bookedCurrentTokenNumbers, maxTokenNumber)
            : resolvedTokenNumber;

        return {
            tokenNumber: resolvedTokenNumber,
            originalTokenNumber: resolvedTokenNumber,
            currentTokenNumber,
        };
    }

    const fixedTokenNumber = getAssignedFixedTokenNumber(requestedTokenNumber, bookedFixedTokenNumbers, maxTokenNumber);
    const currentTokenNumber = getAssignedCurrentTokenNumber(requestedTokenNumber, bookedCurrentTokenNumbers, maxTokenNumber);

    return {
        tokenNumber: fixedTokenNumber,
        originalTokenNumber: fixedTokenNumber,
        currentTokenNumber,
    };
};

module.exports = {
    MAX_TOKEN_NUMBER,
    TOKEN_PLATE_VISIT_TYPE_RULES,
    getBranchTokenPlateRules,
    getBranchMaxTokenNumber,
    isValidTokenPlateLayout,
    supportsTokenPlateVisitType,
    buildSlotTokenPlate,
    getPlateTokenByNumber,
    getNextAvailableTokenNumber,
    getAssignedFixedTokenNumber,
    getAssignedCurrentTokenNumber,
    assignAppointmentTokenNumbers,
    branchLayoutsCache,
    loadBranchLayoutsIntoCache,
};
