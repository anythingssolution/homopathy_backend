const { getRepeatBillTestRows } = require('./repeatBillTests');
const { buildMedicalReportScope, query } = require('./shared');

const getLabTestMedicineItemReport = async (filters) => {
    const { whereClause, params } = buildMedicalReportScope(filters);

    const rows = await query(
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
    const extra = await getRepeatBillTestRows(filters);
    const groups = new Map(rows.map(row => [`${row.item_type}:${row.item_name}:${row.added_by_role}`, { ...row, total_items: Number(row.total_items), total_amount: Number(row.total_amount) }]));
    for (const test of extra) {
        const key = `LAB_TEST:${test.test_name}:MEDICAL`;
        const group = groups.get(key) || { item_type: 'LAB_TEST', item_name: test.test_name, added_by_role: 'MEDICAL', total_items: 0, total_amount: 0 };
        group.total_items += 1; group.total_amount += Number(test.amount); groups.set(key, group);
    }
    return [...groups.values()].sort((a, b) => b.total_items - a.total_items || String(a.item_name).localeCompare(String(b.item_name)));
};

module.exports = getLabTestMedicineItemReport;
