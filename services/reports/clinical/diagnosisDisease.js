const { buildClinicalReportScope, query } = require('./shared');

const getDiagnosisDiseaseReport = async (filters) => {
    const { whereClause, params } = buildClinicalReportScope(filters);

    return query(
        `SELECT
            NULLIF(TRIM(c.disease), '') AS disease,
            NULLIF(TRIM(c.diagnosis), '') AS diagnosis,
            COUNT(c.id) AS total_consultations,
            COUNT(DISTINCT a.fk_patient_id) AS unique_primary_patients
         FROM tbl_consultations c
         JOIN tbl_appointments a ON a.appointment_id = c.appointment_id
         ${whereClause}
         GROUP BY NULLIF(TRIM(c.disease), ''), NULLIF(TRIM(c.diagnosis), '')
         ORDER BY total_consultations DESC, disease ASC, diagnosis ASC`,
        params
    );
};

module.exports = getDiagnosisDiseaseReport;
