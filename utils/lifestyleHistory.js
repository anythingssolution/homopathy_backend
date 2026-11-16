const AppError = require('./AppError');
const choices = {
    sleep_disturbed: ['YES', 'NO'], appetite_disturbed: ['YES', 'NO'],
    irritable_nature: ['YES', 'NO'], stress: ['YES', 'NO'], overthinking: ['YES', 'NO'],
    thirst: ['LOW', 'NORMAL', 'LARGE'], thermal_sensitivity: ['HEAT', 'COLD', 'NEITHER'],
    periods_regular: ['YES', 'NO', 'NOT_APPLICABLE'], family_history: ['YES', 'NO'],
};
function normalizeLifestyleHistory(value) {
    if (value === undefined) return undefined; // Older clients must not erase saved answers.
    if (value === null) return null;
    if (typeof value !== 'object' || Array.isArray(value)) throw new AppError('Invalid lifestyle history', 400);
    const result = { version: 1 };
    for (const [key, allowed] of Object.entries(choices)) {
        const answer = value[key] ?? null;
        if (answer !== null && !allowed.includes(answer)) throw new AppError(`Invalid lifestyle answer: ${key}`, 400);
        result[key] = answer;
    }
    for (const key of ['father_details', 'mother_details']) {
        if (value[key] != null && typeof value[key] !== 'string') throw new AppError(`Invalid ${key}`, 400);
        const detail = (value[key] || '').trim();
        if (detail.length > 5000) throw new AppError(`${key} must be within 5000 characters`, 400);
        result[key] = result.family_history === 'YES' ? detail : '';
    }
    return Object.keys(choices).some(key => result[key] !== null) ? result : null;
}
function readLifestyleHistory(value) {
    if (!value) return null;
    try { return normalizeLifestyleHistory(typeof value === 'string' ? JSON.parse(value) : value); }
    catch { return null; }
}
module.exports = { normalizeLifestyleHistory, readLifestyleHistory };
