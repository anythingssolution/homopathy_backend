const { buildTimestampDateRangeScope, query } = require('../shared');

const getPatientUpdateAuditHistoryReport = async ({ fromDate, toDate }) => {
    const { whereClause, params } = buildTimestampDateRangeScope({
        alias: 'l',
        fromDate,
        toDate,
        branchAlias: null,
    });

    return query(
        `SELECT
            l.id AS audit_id,
            l.user_id AS patient_id,
            p.uuid AS patient_uuid,
            p.full_name AS patient_full_name,
            p.mobile_no AS patient_mobile_no,
            l.changed_by_user_id,
            changed_by.full_name AS changed_by_name,
            l.changed_by_role,
            l.changed_fields_json,
            l.created_at
         FROM log_user_profile_updates l
         JOIN master_users p ON p.id = l.user_id
         LEFT JOIN master_users changed_by ON changed_by.id = l.changed_by_user_id
         ${whereClause}
         ORDER BY l.created_at DESC, l.id DESC`,
        params
    );
};

module.exports = getPatientUpdateAuditHistoryReport;
