const { buildClinicalReportScope, query } = require('./shared');

const getClinicalSummaryReport = async (filters) => {
    const { whereClause, params } = buildClinicalReportScope(filters);

    return query(
        `SELECT
            SUM(CASE WHEN c.consultation_mode = 'PHYSICAL_PRESENT' THEN 1 ELSE 0 END) AS physical_consultations,
            SUM(CASE WHEN c.consultation_mode = 'ON_CALL' THEN 1 ELSE 0 END) AS on_call_consultations,
            COUNT(DISTINCT a.fk_patient_id) AS unique_primary_patients,
            SUM(CASE WHEN NULLIF(TRIM(c.disease), '') IS NOT NULL THEN 1 ELSE 0 END) AS consultations_with_disease,
            SUM(CASE WHEN NULLIF(TRIM(c.diagnosis), '') IS NOT NULL THEN 1 ELSE 0 END) AS consultations_with_diagnosis,
            SUM(CASE
                WHEN NULLIF(TRIM(c.oxygen_saturation), '') IS NOT NULL
                  OR NULLIF(TRIM(c.blood_pressure), '') IS NOT NULL
                  OR NULLIF(TRIM(c.patient_height), '') IS NOT NULL
                  OR NULLIF(TRIM(c.patient_weight), '') IS NOT NULL
                THEN 1
                ELSE 0
            END) AS consultations_with_vitals
         FROM tbl_consultations c
         JOIN tbl_appointments a ON a.appointment_id = c.appointment_id
         ${whereClause}`,
        params
    );
};

module.exports = getClinicalSummaryReport;
