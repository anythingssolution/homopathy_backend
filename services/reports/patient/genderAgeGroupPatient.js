const { buildPatientCreatedScope, query } = require('./shared');

const getGenderAgeGroupPatientReport = async (filters) => {
    const { whereClause, params } = buildPatientCreatedScope(filters);

    return query(
        `SELECT
            p.gender,
            CASE
                WHEN p.age IS NULL THEN 'UNKNOWN'
                WHEN p.age < 13 THEN 'CHILD'
                WHEN p.age BETWEEN 13 AND 19 THEN 'TEEN'
                WHEN p.age BETWEEN 20 AND 39 THEN 'ADULT_20_39'
                WHEN p.age BETWEEN 40 AND 59 THEN 'ADULT_40_59'
                ELSE 'SENIOR_60_PLUS'
            END AS age_group,
            COUNT(p.id) AS total_patients
         FROM master_users p
         ${whereClause}
           AND p.role = 'PAT'
         GROUP BY p.gender, age_group
         ORDER BY p.gender ASC, FIELD(age_group, 'CHILD', 'TEEN', 'ADULT_20_39', 'ADULT_40_59', 'SENIOR_60_PLUS', 'UNKNOWN')`,
        params
    );
};

module.exports = getGenderAgeGroupPatientReport;
