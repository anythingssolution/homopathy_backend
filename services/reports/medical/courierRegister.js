const { buildTimestampDateRangeScope, query } = require('../shared');

const getCourierRegisterReport = async (filters) => {
    const { whereClause, params } = buildTimestampDateRangeScope({
        alias: 'b',
        column: 'created_at',
        fromDate: filters.fromDate,
        toDate: filters.toDate,
        branchAlias: 'b',
        branchId: filters.branchId,
    });

    return query(
        `SELECT
            b.id AS bill_id,
            b.bill_number,
            b.appointment_id,
            b.consultation_id,
            b.patient_id AS fk_patient_id,
            b.fk_branch_id,
            b.gross_amount,
            b.discount_amount,
            b.total_amount,
            b.paid_amount,
            b.pending_amount,
            b.payment_status,
            b.remark AS bill_remark,
            b.delivery_mode,
            b.created_at AS booked_at,
            NULLIF(TRIM(JSON_UNQUOTE(JSON_EXTRACT(b.delivery_details_json, '$.courier_address'))), '') AS courier_address,
            CASE
                WHEN LOWER(TRIM(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(b.delivery_details_json, '$.tracking_no')), ''))) IN ('', 'null', 'undefined') THEN NULL
                ELSE TRIM(JSON_UNQUOTE(JSON_EXTRACT(b.delivery_details_json, '$.tracking_no')))
            END AS tracking_no,
            NULLIF(TRIM(JSON_UNQUOTE(JSON_EXTRACT(b.delivery_details_json, '$.courier_partner'))), '') AS courier_partner,
            NULLIF(TRIM(JSON_UNQUOTE(JSON_EXTRACT(b.delivery_details_json, '$.delivery_remark'))), '') AS delivery_remark,
            COALESCE(fm.full_name, p.full_name) AS patient_full_name,
            p.mobile_no AS patient_mobile_no,
            p.uuid AS patient_uuid,
            COALESCE(fm.age, p.age) AS patient_age,
            COALESCE(fm.gender, p.gender) AS patient_gender,
            a.auid,
            br.branch_name,
            br.address AS branch_address,
            br.contact_no AS branch_contact_no,
            d.full_name AS doctor_name,
            COALESCE(items.medicine_count, 0) AS medicine_count,
            items.medicine_names,
            COALESCE(items.courier_gross, 0) AS courier_gross,
            COALESCE(discounts.courier_discount, 0) AS courier_discount,
            GREATEST(0, COALESCE(items.courier_gross, 0) - COALESCE(discounts.courier_discount, 0)) AS courier_net,
            CASE
                WHEN b.appointment_id IS NOT NULL THEN 'REGULAR'
                WHEN b.consultation_id IS NULL OR b.remark LIKE '%Medical Only%' THEN 'DIRECT'
                ELSE 'REPEAT'
            END AS medicine_type
         FROM tbl_bills b
         JOIN master_users p ON p.id = b.patient_id
         JOIN master_clinic_branches br ON br.id = b.fk_branch_id
         LEFT JOIN tbl_appointments a ON a.appointment_id = b.appointment_id
         LEFT JOIN tbl_patient_family_members fm ON fm.id = a.fk_patient_family_member_id
         LEFT JOIN tbl_consultations c ON c.id = b.consultation_id
         LEFT JOIN master_users d ON d.id = c.doctor_id
         LEFT JOIN (
            SELECT
                bill_id,
                SUM(CASE
                    WHEN item_type IN ('MEDICATION', 'ADDITIONAL_MEDICATION')
                     AND LOWER(COALESCE(item_name, '')) <> 'courier charge' THEN 1
                    ELSE 0
                END) AS medicine_count,
                GROUP_CONCAT(
                    CASE
                        WHEN item_type IN ('MEDICATION', 'ADDITIONAL_MEDICATION')
                         AND LOWER(COALESCE(item_name, '')) <> 'courier charge' THEN item_name
                    END
                    ORDER BY id ASC SEPARATOR ', '
                ) AS medicine_names,
                SUM(CASE WHEN item_type = 'DELIVERY' OR LOWER(item_name) = 'courier charge' THEN amount ELSE 0 END) AS courier_gross
            FROM tbl_bill_items
            GROUP BY bill_id
         ) items ON items.bill_id = b.id
         LEFT JOIN (
            SELECT bill_id, SUM(discount_amount) AS courier_discount
            FROM tbl_bill_discounts
            WHERE status = 'ACTIVE' AND discount_category = 'COURIER'
            GROUP BY bill_id
         ) discounts ON discounts.bill_id = b.id
         ${whereClause}
           AND b.bill_type = 'MEDICATION'
           AND b.delivery_mode = 'COURIER'
           AND b.status = 'ACTIVE'
         ORDER BY b.created_at DESC, b.id DESC`,
        params
    );
};

module.exports = getCourierRegisterReport;
