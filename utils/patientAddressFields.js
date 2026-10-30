const AppError = require('./AppError');

// Undefined preserves stored data; an explicit empty value clears an optional field.
const normalizeOptionalAddressFields = (body) => {
    const result = {};
    for (const [field, maxLength] of [['ward_no', 50], ['vidhan_sabha', 150], ['state_name', 100]]) {
        if (body[field] === undefined) continue;
        if (body[field] !== null && typeof body[field] !== 'string') {
            throw new AppError(`${field} must be text`, 400);
        }
        const value = body[field] == null ? null : body[field].trim() || null;
        if (value && value.length > maxLength) throw new AppError(`${field} must be at most ${maxLength} characters`, 400);
        result[field] = value;
    }
    return result;
};
module.exports = { normalizeOptionalAddressFields };
