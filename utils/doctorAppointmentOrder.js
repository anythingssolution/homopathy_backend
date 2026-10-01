const timestamp = (value) => {
    if (!value) return 0;
    const normalized = value instanceof Date
        ? value
        : new Date(String(value).replace(' ', 'T'));
    const parsed = normalized.getTime();
    return Number.isFinite(parsed) ? parsed : 0;
};

const number = (value) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
};

/**
 * Completed consultations are a history list, so they use the persisted
 * completion sequence rather than the active live-queue projection.
 */
const sortCompletedAppointmentsRecentFirst = (rows = []) => [...rows].sort((left, right) => {
    const dateDifference = timestamp(right.appointment_date) - timestamp(left.appointment_date);
    if (dateDifference !== 0) return dateDifference;

    const completionDifference = timestamp(right.actual_completed_at) - timestamp(left.actual_completed_at);
    if (completionDifference !== 0) return completionDifference;

    const positionDifference = number(right.queue_position) - number(left.queue_position);
    if (positionDifference !== 0) return positionDifference;

    const createdDifference = timestamp(right.created_at) - timestamp(left.created_at);
    if (createdDifference !== 0) return createdDifference;

    return number(right.appointment_id) - number(left.appointment_id);
});

module.exports = { sortCompletedAppointmentsRecentFirst };
