const MAX_ACTIVE_FAMILY_MEMBERS = 5;
let familyBookingSchemaCache = null;

const BOOKED_FOR_TYPES = {
    SELF: 'SELF',
    FAMILY_MEMBER: 'FAMILY_MEMBER',
};

const normalizeBookedForType = (value) => {
    const normalized = String(value || '').trim().toUpperCase();
    if (!normalized) {
        return BOOKED_FOR_TYPES.SELF;
    }

    return Object.values(BOOKED_FOR_TYPES).includes(normalized) ? normalized : null;
};

const getAppointmentPatientColumns = ({
    appointmentAlias = 'a',
    patientAlias = 'p',
    familyAlias = 'fm',
} = {}) => `
    ${appointmentAlias}.booked_for_type,
    ${appointmentAlias}.fk_patient_family_member_id,
    CASE WHEN ${appointmentAlias}.booked_for_type = '${BOOKED_FOR_TYPES.FAMILY_MEMBER}' THEN 1 ELSE 0 END AS is_family_member_booking,
    ${familyAlias}.relationship AS family_member_relationship,
    ${familyAlias}.full_name AS family_member_full_name,
    ${familyAlias}.age AS family_member_age,
    ${familyAlias}.gender AS family_member_gender,
    ${familyAlias}.description AS family_member_description,
    ${patientAlias}.id AS patient_id,
    ${patientAlias}.uuid AS patient_uuid,
    ${patientAlias}.full_name AS primary_patient_full_name,
    ${patientAlias}.age AS primary_patient_age,
    ${patientAlias}.gender AS primary_patient_gender,
    ${patientAlias}.email AS primary_patient_email,
    ${patientAlias}.mobile_no AS primary_patient_mobile_no,
    ${patientAlias}.description AS primary_patient_description,
    COALESCE(${familyAlias}.full_name, ${patientAlias}.full_name) AS patient_full_name,
    COALESCE(${familyAlias}.age, ${patientAlias}.age) AS patient_age,
    COALESCE(${familyAlias}.gender, ${patientAlias}.gender) AS patient_gender,
    ${patientAlias}.email AS patient_email,
    ${patientAlias}.mobile_no AS patient_mobile_no,
    COALESCE(${familyAlias}.description, ${patientAlias}.description) AS patient_description,
    COALESCE(${familyAlias}.full_name, ${patientAlias}.full_name) AS visiting_patient_full_name,
    COALESCE(${familyAlias}.age, ${patientAlias}.age) AS visiting_patient_age,
    COALESCE(${familyAlias}.gender, ${patientAlias}.gender) AS visiting_patient_gender,
    ${patientAlias}.mobile_no AS visiting_patient_mobile_no,
    COALESCE(${familyAlias}.description, ${patientAlias}.description) AS visiting_patient_description
`;

const getAppointmentPatientJoin = ({
    appointmentAlias = 'a',
    patientAlias = 'p',
    familyAlias = 'fm',
} = {}) => `
    JOIN master_users ${patientAlias} ON ${patientAlias}.id = ${appointmentAlias}.fk_patient_id
    LEFT JOIN tbl_patient_family_members ${familyAlias}
      ON ${familyAlias}.id = ${appointmentAlias}.fk_patient_family_member_id
`;

const getBookingSubjectExpression = (appointmentAlias = 'a') => `
    CASE
        WHEN ${appointmentAlias}.booked_for_type = '${BOOKED_FOR_TYPES.FAMILY_MEMBER}'
         AND ${appointmentAlias}.fk_patient_family_member_id IS NOT NULL THEN CONCAT('FM:', ${appointmentAlias}.fk_patient_family_member_id)
        ELSE CONCAT('SELF:', ${appointmentAlias}.fk_patient_id)
    END
`;

const buildBookingConflictCondition = ({
    bookedForType,
    primaryPatientId,
    familyMemberId = null,
    appointmentAlias = '',
}) => {
    const appointmentPrefix = appointmentAlias ? `${appointmentAlias}.` : '';

    if (bookedForType === BOOKED_FOR_TYPES.FAMILY_MEMBER) {
        return {
            sql: `${appointmentPrefix}booked_for_type = ? AND ${appointmentPrefix}fk_patient_family_member_id = ?`,
            params: [BOOKED_FOR_TYPES.FAMILY_MEMBER, familyMemberId],
        };
    }

    return {
        sql: `${appointmentPrefix}booked_for_type = ? AND ${appointmentPrefix}fk_patient_id = ?`,
        params: [BOOKED_FOR_TYPES.SELF, primaryPatientId],
    };
};

const getBookingSubjectKey = ({
    bookedForType,
    primaryPatientId,
    familyMemberId = null,
}) => {
    if (bookedForType === BOOKED_FOR_TYPES.FAMILY_MEMBER) {
        return `FM:${familyMemberId}`;
    }

    return `SELF:${primaryPatientId}`;
};

const getFamilyBookingSchemaState = async ({ connection = null, queryFn = null, forceRefresh = false } = {}) => {
    if (!forceRefresh && familyBookingSchemaCache?.enabled) {
        return familyBookingSchemaCache;
    }

    const executor = connection
        ? async (sql, params = []) => {
            const [rows] = await connection.execute(sql, params);
            return rows;
        }
        : queryFn;

    if (typeof executor !== 'function') {
        throw new Error('getFamilyBookingSchemaState requires either connection or queryFn');
    }

    const [tableRows, columnRows] = await Promise.all([
        executor(
            `SELECT COUNT(*) AS total
             FROM information_schema.tables
             WHERE table_schema = DATABASE()
               AND table_name = 'tbl_patient_family_members'`
        ),
        executor(
            `SELECT column_name
             FROM information_schema.columns
             WHERE table_schema = DATABASE()
               AND table_name = 'tbl_appointments'
               AND column_name IN ('fk_patient_family_member_id', 'booked_for_type', 'booking_subject_key')`
        ),
    ]);

    const columnSet = new Set(columnRows.map((row) => String(row.column_name || row.COLUMN_NAME || '').trim().toLowerCase()));
    const isEnabled =
        Number(tableRows[0]?.total || 0) > 0 &&
        columnSet.has('fk_patient_family_member_id') &&
        columnSet.has('booked_for_type') &&
        columnSet.has('booking_subject_key');

    familyBookingSchemaCache = {
        enabled: isEnabled,
    };

    return familyBookingSchemaCache;
};

module.exports = {
    MAX_ACTIVE_FAMILY_MEMBERS,
    BOOKED_FOR_TYPES,
    normalizeBookedForType,
    getAppointmentPatientColumns,
    getAppointmentPatientJoin,
    getBookingSubjectExpression,
    buildBookingConflictCondition,
    getBookingSubjectKey,
    getFamilyBookingSchemaState,
};
