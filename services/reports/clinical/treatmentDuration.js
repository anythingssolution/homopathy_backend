const { buildClinicalReportScope, query } = require('./shared');

const getTreatmentDurationReport = async (filters) => {
    const { whereClause, params } = buildClinicalReportScope(filters);

    return query(
        `SELECT
            c.medication_duration_days,
            COUNT(c.id) AS total_consultations,
            COUNT(DISTINCT a.fk_patient_id) AS unique_primary_patients,
            MIN(a.appointment_date) AS first_appointment_date,
            MAX(a.appointment_date) AS last_appointment_date
         FROM tbl_consultations c
         JOIN tbl_appointments a ON a.appointment_id = c.appointment_id
         ${whereClause}
         GROUP BY c.medication_duration_days
         ORDER BY c.medication_duration_days ASC`,
        params
    );
};

module.exports = getTreatmentDurationReport;
