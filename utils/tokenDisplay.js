const TIME_REGEX = /^(\d{2}):(\d{2})(?::(\d{2}))?$/;
const SQL_DATETIME_TIME_REGEX = /^\d{4}-\d{2}-\d{2}[ T](\d{2}:\d{2}:\d{2})$/;

const safeParseDate = (val) => {
    if (!val) return null;
    if (val instanceof Date) return val;
    const str = String(val).trim();
    if (!str) return null;
    if (str.includes('Z') || str.includes('+') || (str.includes('-') && str.indexOf('-') !== str.lastIndexOf('-') && str.includes('T'))) {
        const d = new Date(str);
        if (!isNaN(d.getTime())) return d;
    }
    const normalized = str.replace(' ', 'T');
    const d = new Date(`${normalized}+05:30`);
    if (!isNaN(d.getTime())) return d;
    return new Date(str);
};

const resolveTokenPrefix = ({ slotName = null, startTime = null } = {}) => {
    const normalizedSlotName = String(slotName || '').trim().toLowerCase();

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

    const match = String(startTime || '').trim().match(TIME_REGEX);
    if (!match) {
        return null;
    }

    const hour = Number(match[1]);
    if (!Number.isInteger(hour)) {
        return null;
    }

    return hour < 12 ? 'M' : 'E';
};

const formatTokenDisplay = (tokenNumber, context = {}) => {
    const parsed = Number(tokenNumber);
    if (!Number.isInteger(parsed) || parsed <= 0) {
        return null;
    }

    const prefix = resolveTokenPrefix(context);
    return prefix ? `${prefix}-${parsed}` : String(parsed);
};

const extractTimeFromDateTime = (value) => {
    const normalizedValue = String(value || '').trim();

    if (!normalizedValue) {
        return null;
    }

    if (TIME_REGEX.test(normalizedValue)) {
        return normalizedValue.length === 5 ? `${normalizedValue}:00` : normalizedValue;
    }

    const match = normalizedValue.match(SQL_DATETIME_TIME_REGEX);
    return match ? match[1] : null;
};

const decorateTokenFields = (
    payload,
    {
        slotNameField = 'slot_name',
        startTimeField = 'start_time',
        endTimeField = 'end_time',
        tokenField = 'token_number',
        currentTokenField = 'current_token_number',
        originalTokenField = 'original_token_number',
        plannedStartAtField = 'planned_start_at',
        plannedEndAtField = 'planned_end_at',
        checkedInAtField = 'checked_in_at',
    } = {}
) => {
    if (!payload || typeof payload !== 'object') {
        return payload;
    }

    const context = {
        slotName: payload[slotNameField] ?? null,
        startTime: payload[startTimeField] ?? null,
    };
    const currentTokenValue = payload[currentTokenField] ?? payload[tokenField] ?? null;
    const originalTokenValue = payload[originalTokenField] ?? null;
    const displayTokenValue = originalTokenValue ?? currentTokenValue ?? payload[tokenField] ?? null;
    const plannedStartTime = extractTimeFromDateTime(payload[plannedStartAtField]);
    const plannedEndTime = extractTimeFromDateTime(payload[plannedEndAtField]);
    const checkedInTime = extractTimeFromDateTime(payload[checkedInAtField]);

    let templateStartTime = null;
    let templateStartDateTime = null;
    try {
        const branchId = payload.fk_branch_id;
        const slotId = payload.fk_slot_id;
        let appointmentDate = payload.appointment_date;
        const slotStartTime = payload[startTimeField] || payload.slot_start_time;
        const tokenNumber = payload[tokenField];

        if (branchId && slotId && appointmentDate && slotStartTime && tokenNumber) {
            if (appointmentDate instanceof Date) {
                const yyyy = appointmentDate.getFullYear();
                const mm = String(appointmentDate.getMonth() + 1).padStart(2, '0');
                const dd = String(appointmentDate.getDate()).padStart(2, '0');
                appointmentDate = `${yyyy}-${mm}-${dd}`;
            } else if (typeof appointmentDate === 'string') {
                appointmentDate = appointmentDate.split(/[ T]/)[0];
            }
            const { buildSlotTokenPlate } = require('./appointmentTokens');
            const plate = buildSlotTokenPlate({
                branchId,
                slotId,
                appointmentDate,
                slotStartTime,
            });
            const token = plate.find(t => Number(t.token_number) === Number(tokenNumber));
            if (token) {
                templateStartTime = token.estimated_start_at;
                const [year, month, day] = String(appointmentDate).split('-').map(Number);
                const [hour, minute] = String(templateStartTime).split(':').map(Number);
                templateStartDateTime = new Date(year, month - 1, day, hour, minute, 0);
            }
        }
    } catch (e) {
        // ignore
    }

    const liveEstimatedStartAt = payload.live_estimated_start_at ?? null;
    const plannedStartAt = payload[plannedStartAtField] ?? null;
    const checkedInAt = payload[checkedInAtField] ?? payload.checked_in_at ?? null;
    const bookingTime = payload.created_at ?? payload.booking_time ?? templateStartDateTime ?? plannedStartAt;
    let liveDelayMinutes = 0;

    if (checkedInAt && plannedStartAt) {
        const checkInDate = safeParseDate(checkedInAt);
        const plannedDate = safeParseDate(plannedStartAt);
        if (checkInDate && plannedDate) {
            liveDelayMinutes = Math.max(0, Math.round((checkInDate.getTime() - plannedDate.getTime()) / (60 * 1000)));
        }
    }

    return {
        ...payload,
        token_display: formatTokenDisplay(payload[tokenField], context),
        current_token_display: formatTokenDisplay(currentTokenValue, context),
        original_token_display: formatTokenDisplay(originalTokenValue, context),
        display_token_number: displayTokenValue,
        display_token_display: formatTokenDisplay(displayTokenValue, context),
        slot_start_time: payload[startTimeField] ?? null,
        slot_end_time: payload[endTimeField] ?? null,
        scheduled_start_time: plannedStartTime || payload[startTimeField] || null,
        scheduled_end_time: plannedEndTime || payload[endTimeField] || null,
        checked_in_time: checkedInTime,
        checked_in_time_display: checkedInTime,
        live_estimated_start_at: liveEstimatedStartAt,
        live_estimated_end_at: payload.live_estimated_end_at ?? null,
        live_delay_minutes: liveDelayMinutes,
        template_start_time: templateStartTime,
    };
};

module.exports = {
    resolveTokenPrefix,
    formatTokenDisplay,
    extractTimeFromDateTime,
    decorateTokenFields,
};
