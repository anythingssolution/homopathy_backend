const { buildMedicalReportScope, query } = require('./shared');

const getLabTestMedicineItemReport = async (filters) => {
    const { whereClause, params } = buildMedicalReportScope(filters);

    return query(
        `SELECT
            item_type,
            item_name,
            added_by_role,
            COUNT(*) AS total_items,
            COALESCE(SUM(amount), 0) AS total_amount
         FROM (
            SELECT
                'MEDICINE' AS item_type,
                cm.medicine_value AS item_name,
                cm.added_by_role,
                NULL AS amount,
                c.id AS consultation_id,
                a.appointment_date,
                a.fk_branch_id
            FROM tbl_consultation_medications cm
            JOIN tbl_consultations c ON c.id = cm.consultation_id
            JOIN tbl_appointments a ON a.appointment_id = c.appointment_id
            ${whereClause}
            UNION ALL
            SELECT
                'LAB_TEST' AS item_type,
                ct.test_name AS item_name,
                'DOCTOR' AS added_by_role,
                ct.amount,
                c.id AS consultation_id,
                a.appointment_date,
                a.fk_branch_id
            FROM tbl_consultation_tests ct
            JOIN tbl_consultations c ON c.id = ct.consultation_id
            JOIN tbl_appointments a ON a.appointment_id = c.appointment_id
            ${whereClause}
         ) items
         GROUP BY item_type, item_name, added_by_role
         ORDER BY total_items DESC, item_type ASC, item_name ASC`,
        [...params, ...params]
    );
};

module.exports = getLabTestMedicineItemReport;
