const { buildMedicalReportScope, query } = require('./shared');

const getMedicalProcessedByUserReport = async (filters) => {
    const { whereClause, params } = buildMedicalReportScope(filters);

    return query(
        `SELECT
            c.medical_processed_by AS user_id,
            processor.full_name AS processed_by_name,
            COUNT(c.id) AS processed_prescriptions,
            MIN(c.medical_processed_at) AS first_processed_at,
            MAX(c.medical_processed_at) AS last_processed_at
         FROM tbl_consultations c
         JOIN tbl_appointments a ON a.appointment_id = c.appointment_id
         LEFT JOIN master_users processor ON processor.id = c.medical_processed_by
         ${whereClause}
           AND c.medical_processed_at IS NOT NULL
         GROUP BY c.medical_processed_by, processor.full_name
         ORDER BY processed_prescriptions DESC, processed_by_name ASC`,
        params
    );
};

module.exports = getMedicalProcessedByUserReport;
