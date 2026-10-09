const { buildTimestampDateRangeScope, query } = require('../shared');

const getRepeatBillTestRows = async (filters) => {
    const { whereClause, params } = buildTimestampDateRangeScope({
        alias: 'b', fromDate: filters.fromDate, toDate: filters.toDate, branchId: filters.branchId,
    });
    return query(`SELECT
        CONCAT('bill-test-', bi.id) AS consultation_test_id,
        'BILL' AS test_source, b.id AS bill_id, b.bill_number,
        NULL AS consultation_id, NULL AS appointment_id,
        DATE(b.created_at) AS appointment_date, b.created_at AS recommended_at,
        bi.item_name AS test_name, bi.amount, 'ACTIVE' AS dispense_status,
        NULL AS finding_text, NULL AS interpreted_at,
        b.patient_id AS fk_patient_id, b.fk_branch_id,
        COALESCE(fm.full_name, p.full_name) AS patient_full_name,
        COALESCE(fm.age, p.age) AS patient_age,
        COALESCE(fm.gender, p.gender) AS patient_gender,
        p.mobile_no AS patient_mobile_no, p.uuid AS patient_uuid,
        c.doctor_id, d.full_name AS doctor_name,
        CASE WHEN b.remark LIKE '%Medical Only%' OR b.consultation_id IS NULL
             THEN 'Direct Medicine' ELSE 'Repeat Medicine' END AS treatment_name,
        'Medical' AS slot_name, NULL AS token_number, '—' AS display_token_display
     FROM tbl_bill_items bi
     JOIN tbl_bills b ON b.id = bi.bill_id
     JOIN master_users p ON p.id = b.patient_id
     LEFT JOIN tbl_consultations c ON c.id = b.consultation_id
     LEFT JOIN tbl_appointments source_a ON source_a.appointment_id = c.appointment_id
     LEFT JOIN tbl_patient_family_members fm ON fm.id = source_a.fk_patient_family_member_id
     LEFT JOIN master_users d ON d.id = c.doctor_id
     ${whereClause}
       AND b.status = 'ACTIVE' AND b.bill_type = 'MEDICATION' AND b.appointment_id IS NULL
       AND bi.item_type = 'TEST' AND bi.consultation_test_id IS NULL
     ORDER BY b.created_at DESC, b.id DESC, bi.id ASC`, params);
};

module.exports = { getRepeatBillTestRows };
