const AppError = require('./AppError');

const normalizeBookingPatientUpdates = (updates, patientId) => {
    if (updates === undefined) return {};
    if (!patientId || !updates || typeof updates !== 'object' || Array.isArray(updates)) {
        throw new AppError('patient_updates requires an existing patient account', 400);
    }
    const normalized = {};
    for (const [field, value] of Object.entries(updates)) {
        if (!['full_name', 'mobile_no', 'age', 'gender'].includes(field)) {
            throw new AppError(`Unsupported patient correction: ${field}`, 400);
        }
        normalized[field] = field === 'age' ? Number(value) : String(value ?? '').trim();
        if (field === 'full_name' && (!normalized[field] || normalized[field].length > 100)) {
            throw new AppError('Patient name must contain 1 to 100 characters', 400);
        }
        if (field === 'mobile_no' && !/^\d{10,15}$/.test(normalized[field])) {
            throw new AppError('Patient mobile number must contain 10 to 15 digits', 400);
        }
        if (field === 'age' && (!Number.isInteger(normalized[field]) || normalized[field] < 1 || normalized[field] > 120)) {
            throw new AppError('Patient age must be between 1 and 120', 400);
        }
        if (field === 'gender') {
            normalized[field] = normalized[field].toLowerCase();
            if (!['male', 'female', 'other'].includes(normalized[field])) {
                throw new AppError('Please select a valid patient gender', 400);
            }
        }
    }
    return normalized;
};

// Use the booking transaction so a failed appointment also rolls back corrections.
const saveBookingPatientUpdates = async (connection, patient, updates, actor) => {
    const fields = Object.keys(updates).filter(field => String(updates[field]) !== String(patient[field] ?? ''));
    if (!fields.length) return;
    if (fields.includes('mobile_no')) {
        const [duplicates] = await connection.execute(
            'SELECT id FROM master_users WHERE mobile_no = ? AND id <> ? LIMIT 1 FOR UPDATE',
            [updates.mobile_no, patient.id]
        );
        if (duplicates.length) throw new AppError('Mobile number already in use by another user', 409);
    }
    await connection.execute(
        `UPDATE master_users SET ${fields.map(field => `${field} = ?`).join(', ')}, updated_by = ?, updated_ip = ? WHERE id = ?`,
        [...fields.map(field => updates[field]), actor.id, actor.ip, patient.id]
    );
    await connection.execute(
        `INSERT INTO log_user_profile_updates
         (user_id, changed_by_user_id, changed_by_role, ip_address, user_agent, changed_fields_json, old_values_json, new_values_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [patient.id, actor.id, actor.role, actor.ip, actor.userAgent,
            JSON.stringify(fields),
            JSON.stringify(Object.fromEntries(fields.map(field => [field, patient[field]]))),
            JSON.stringify(Object.fromEntries(fields.map(field => [field, updates[field]])))]
    );
};

module.exports = { normalizeBookingPatientUpdates, saveBookingPatientUpdates };
