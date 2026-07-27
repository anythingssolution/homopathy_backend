const { buildPatientCreatedScope, query } = require('./shared');

const getPatientMasterListReport = async (filters) => {
    const { whereClause, params } = buildPatientCreatedScope(filters);

    return query(
        `SELECT
            p.id AS patient_id,
            p.uuid AS patient_uuid,
            p.full_name,
            p.age,
            p.gender,
            p.email,
            p.mobile_no,
            p.is_active,
            p.created_at,
            COUNT(DISTINCT fm.id) AS active_family_members
         FROM master_users p
         LEFT JOIN tbl_patient_family_members fm
           ON fm.fk_primary_patient_id = p.id
          AND fm.is_active = 1
         ${whereClause}
           AND p.role = 'PAT'
         GROUP BY p.id, p.uuid, p.full_name, p.age, p.gender, p.email, p.mobile_no, p.is_active, p.created_at
         ORDER BY p.created_at DESC, p.full_name ASC`,
        params
    );
};

module.exports = getPatientMasterListReport;
