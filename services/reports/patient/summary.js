const { buildPatientCreatedScope, query } = require('./shared');

const getPatientSummaryReport = async (filters) => {
    const { whereClause, params } = buildPatientCreatedScope(filters);

    return query(
        `SELECT
            SUM(CASE WHEN patient_rows.is_active = 1 THEN 1 ELSE 0 END) AS active_primary_patients,
            SUM(CASE WHEN patient_rows.is_active = 0 THEN 1 ELSE 0 END) AS inactive_primary_patients,
            SUM(CASE WHEN patient_rows.active_family_members > 0 THEN 1 ELSE 0 END) AS patients_with_family_members,
            SUM(CASE WHEN patient_rows.active_family_members = 0 THEN 1 ELSE 0 END) AS patients_without_family_members,
            ROUND(AVG(patient_rows.age), 2) AS average_patient_age,
            SUM(CASE WHEN patient_rows.age IS NOT NULL AND patient_rows.age < 18 THEN 1 ELSE 0 END) AS minor_patients,
            SUM(CASE WHEN patient_rows.age IS NOT NULL AND patient_rows.age BETWEEN 18 AND 59 THEN 1 ELSE 0 END) AS adult_patients,
            SUM(CASE WHEN patient_rows.age IS NOT NULL AND patient_rows.age >= 60 THEN 1 ELSE 0 END) AS senior_patients
         FROM (
            SELECT
                p.id,
                p.age,
                p.is_active,
                COUNT(fm.id) AS active_family_members
            FROM master_users p
            LEFT JOIN tbl_patient_family_members fm
              ON fm.fk_primary_patient_id = p.id
             AND fm.is_active = 1
            ${whereClause}
              AND p.role = 'PAT'
            GROUP BY p.id, p.age, p.is_active
         ) patient_rows`,
        params
    );
};

module.exports = getPatientSummaryReport;
