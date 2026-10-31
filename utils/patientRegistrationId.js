const AppError = require('./AppError');

const normalizePatientRegistrationId = (value) => {
    let uuid = String(value ?? '').replace(/\s+/g, '').toUpperCase();
    if (/^[1-9]\d*$/.test(uuid)) uuid = `DTH${uuid}`;
    if (uuid.length > 36 || !/^DTH_?[1-9]\d*$/.test(uuid)) {
        throw new AppError('Registration number must be DTH or DTH_ followed by a positive number', 400);
    }
    uuid = uuid.replace(/^DTH_?/, 'DTH_');
    if (uuid.length > 36) throw new AppError('Registration number is too long', 400);
    return uuid;
};

const assertRegistrationIdAvailable = async (connection, uuid, patientId = null) => {
    if (!uuid) return;
    // Lock the counter before a uniqueness gap lock, matching allocation lock order.
    // The enclosing transaction rolls this reservation back on validation failure.
    await connection.execute(
        'UPDATE tbl_patient_registration_sequence SET last_serial = GREATEST(last_serial, CAST(? AS UNSIGNED)) WHERE id = 1',
        [uuid.replace(/^DTH_?/, '')]
    );
    const [rows] = await connection.execute(
        `SELECT id FROM master_users WHERE uuid = ? ${patientId ? 'AND id <> ?' : ''} LIMIT 1 FOR UPDATE`,
        patientId ? [uuid, patientId] : [uuid]
    );
    if (rows.length) throw new AppError('Registration number already belongs to another patient', 409);
};

const auditRegistrationIdChange = async (connection, { patientId, oldUuid, uuid, actor, ip }) => {
    if (oldUuid === uuid) return;
    await connection.execute(
        `INSERT INTO log_user_profile_updates
         (user_id, changed_by_user_id, changed_by_role, ip_address, changed_fields_json, old_values_json, new_values_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [patientId, actor.id, actor.role_code || actor.role, ip, JSON.stringify(['uuid']),
            JSON.stringify({ uuid: oldUuid }), JSON.stringify({ uuid })]
    );
};

module.exports = { normalizePatientRegistrationId, assertRegistrationIdAvailable, auditRegistrationIdChange };
