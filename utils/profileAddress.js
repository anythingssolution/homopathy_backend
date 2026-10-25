const AppError = require('./AppError');
const { normalizeOptionalAddressFields } = require('./patientAddressFields');
const FIELDS = ['area_name', 'city', 'pincode', 'ward_no', 'vidhan_sabha'];
const text = value => value == null ? null : String(value).trim() || null;
const legacyAreaValue = existing => {
    let area = text(existing.address) || '';
    for (const part of [existing.city, existing.pincode, existing.vidhan_sabha, existing.ward_no ? `Ward ${existing.ward_no}` : null]) {
        const suffix = text(part);
        if (!suffix) continue;
        if (area.toLowerCase() === suffix.toLowerCase()) area = '';
        else if (area.toLowerCase().endsWith(`, ${suffix}`.toLowerCase())) area = area.slice(0, -(suffix.length + 2)).trim();
    }
    return area || null;
};
function buildProfileAddressUpdate(body, existing) {
    if (!FIELDS.some(field => body[field] !== undefined)) return null;
    for (const field of FIELDS) {
        if (body[field] !== undefined && body[field] !== null && typeof body[field] !== 'string') {
            throw new AppError(`${field} must be text`, 400);
        }
    }
    const optionalFields = normalizeOptionalAddressFields(body);
    const effective = { ...existing, ...optionalFields };
    const area = body.area_name !== undefined ? text(body.area_name) : text(existing.area_name) || legacyAreaValue(existing);
    const city = body.city !== undefined ? text(body.city) : text(existing.city);
    const pincode = body.pincode !== undefined ? text(body.pincode) : text(existing.pincode);
    if (!city) throw new AppError('city is required', 400);
    if (city.length > 100) throw new AppError('city must be at most 100 characters', 400);
    if (area && area.length > 150) throw new AppError('area_name must be at most 150 characters', 400);
    if (pincode && !/^\d{6}$/.test(pincode)) throw new AppError('pincode must contain exactly 6 digits', 400);
    const address = [area, effective.ward_no ? `Ward ${effective.ward_no}` : null,
        effective.vidhan_sabha, pincode, city].filter(Boolean).join(', ');
    return {area_name:area,city,pincode,...optionalFields,address};
}
module.exports = {buildProfileAddressUpdate};
