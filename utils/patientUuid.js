const AppError = require('./AppError');

// New patient IDs use DTH_9990, DTH_9991, ... alongside existing DTH IDs.
const PATIENT_UUID_PREFIX = 'DTH_';
const PATIENT_UUID_FIRST_SERIAL = 9990;
const PATIENT_UUID_LOCK_NAME = 'patient_uuid_sequence';
const PATIENT_UUID_LOCK_TIMEOUT_SEC = 10;

const buildPatientUuid = (serial) => `${PATIENT_UUID_PREFIX}${serial}`;

// Called inside the successful attendance transaction. The patient row makes
// retries idempotent; the singleton counter serializes allocations across branches.
const ensurePatientRegistration = async (connection, patientId) => {
    const [patients] = await connection.execute(
        "SELECT id, uuid FROM master_users WHERE id = ? AND role = 'PAT' LIMIT 1 FOR UPDATE", [patientId]
    );
    if (!patients.length) throw new AppError('Patient account not found', 404);
    if (patients[0].uuid) return patients[0].uuid;
    const [sequence] = await connection.execute(
        'SELECT last_serial FROM tbl_patient_registration_sequence WHERE id = 1 FOR UPDATE'
    );
    if (!sequence.length) throw new AppError('Patient registration sequence is not configured', 503);
    const serial = BigInt(sequence[0].last_serial) + 1n;
    const uuid = buildPatientUuid(serial);
    await connection.execute('UPDATE tbl_patient_registration_sequence SET last_serial = ? WHERE id = 1', [serial.toString()]);
    await connection.execute('UPDATE master_users SET uuid = ? WHERE id = ? AND uuid IS NULL', [uuid, patientId]);
    return uuid;
};

/**
 * Generates the next patient uuid inside an open transaction.
 *
 * - Both DTH9989 and DTH_9990 contribute to the same numeric sequence.
 * - The read uses FOR UPDATE so it sees the latest committed row instead of the
 *   transaction's snapshot, and waits for any in-flight insert to commit first.
 * - GET_LOCK serialises concurrent generators; the UNIQUE index on master_users.uuid
 *   remains the final guarantee against duplicates.
 */
const generatePatientUuid = async (connection) => {
    const [lockRows] = await connection.execute('SELECT GET_LOCK(?, ?) AS acquired_lock', [
        PATIENT_UUID_LOCK_NAME,
        PATIENT_UUID_LOCK_TIMEOUT_SEC,
    ]);

    if (!lockRows[0]?.acquired_lock) {
        throw new AppError('Unable to generate patient ID right now. Please try again.', 503);
    }

    try {
        const [rows] = await connection.execute(
            `SELECT MAX(CAST(SUBSTRING(REPLACE(uuid, '_', ''), 4) AS UNSIGNED)) AS last_serial
             FROM master_users
             WHERE uuid REGEXP ?
             FOR UPDATE`,
            ['^DTH_?[0-9]+$']
        );

        const lastSerial = Number(rows[0]?.last_serial) || 0;
        const nextSerial = Math.max(lastSerial + 1, PATIENT_UUID_FIRST_SERIAL);

        return buildPatientUuid(nextSerial);
    } finally {
        await connection.execute('DO RELEASE_LOCK(?)', [PATIENT_UUID_LOCK_NAME]);
    }
};

module.exports = {
    PATIENT_UUID_PREFIX,
    PATIENT_UUID_FIRST_SERIAL,
    buildPatientUuid,
    generatePatientUuid,
    ensurePatientRegistration,
};
