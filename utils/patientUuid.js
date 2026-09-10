const AppError = require('./AppError');

// Public patient ID format: DTH10000, DTH10001, DTH10002, ... (global, never resets).
const PATIENT_UUID_PREFIX = 'DTH';
const PATIENT_UUID_FIRST_SERIAL = 10000;
const PATIENT_UUID_LOCK_NAME = 'patient_uuid_sequence';
const PATIENT_UUID_LOCK_TIMEOUT_SEC = 10;

const buildPatientUuid = (serial) => `${PATIENT_UUID_PREFIX}${serial}`;

/**
 * Generates the next patient uuid inside an open transaction.
 *
 * - The serial is compared numerically (not as a string), so DTH99999 -> DTH100000 is safe.
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
            `SELECT MAX(CAST(SUBSTRING(uuid, ?) AS UNSIGNED)) AS last_serial
             FROM master_users
             WHERE uuid LIKE ?
             FOR UPDATE`,
            [PATIENT_UUID_PREFIX.length + 1, `${PATIENT_UUID_PREFIX}%`]
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
};
