const parseDeliveryDetails = (value) => {
    if (!value) return {};
    try {
        return typeof value === 'string' ? JSON.parse(value) : value;
    } catch {
        return {};
    }
};

const getLastCourierDelivery = async ({ patientId, branchId = null, queryFn = null }) => {
    const runQuery = queryFn || require('../config/db').query;
    const conditions = [
        'b.patient_id = ?',
        "b.delivery_mode = 'COURIER'",
        "b.status = 'ACTIVE'",
        "NULLIF(TRIM(JSON_UNQUOTE(JSON_EXTRACT(b.delivery_details_json, '$.courier_address'))), '') IS NOT NULL",
    ];
    const params = [patientId];
    if (branchId) {
        conditions.push('b.fk_branch_id = ?');
        params.push(branchId);
    }

    const rows = await runQuery(
        `SELECT b.id AS bill_id, b.delivery_details_json, b.updated_at, b.created_at
         FROM tbl_bills b
         WHERE ${conditions.join(' AND ')}
         ORDER BY COALESCE(b.updated_at, b.created_at) DESC, b.id DESC
         LIMIT 1`,
        params
    );
    if (rows.length === 0) return null;

    const details = parseDeliveryDetails(rows[0].delivery_details_json);
    return {
        courier_address: String(details.courier_address || '').trim(),
        received_by: details.received_by ? String(details.received_by).trim() : null,
        last_used_at: rows[0].updated_at || rows[0].created_at,
    };
};

module.exports = { getLastCourierDelivery };
