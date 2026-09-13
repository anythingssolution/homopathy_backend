const AppError = require('../utils/AppError');

// Keep medication identities stable: existing bills reference these primary keys.
const saveAdditionalMedications = async ({ connection, consultationId, pricingId, items }) => {
    const [existing] = await connection.execute(
        `SELECT id FROM tbl_consultation_medications
         WHERE consultation_id = ? AND medicine_type = 'TEXT' AND added_by_role = 'MEDICAL'
         FOR UPDATE`, [consultationId]);
    const existingIds = new Set(existing.map(row => Number(row.id)));
    const submittedIds = new Set();
    for (const item of items) {
        const id = item.consultation_medication_id;
        if (!id) continue;
        if (!existingIds.has(Number(id))) throw new AppError('Additional medicine does not belong to this consultation. Please reload.', 409);
        if (submittedIds.has(Number(id))) throw new AppError('Duplicate additional medicine ID', 400);
        submittedIds.add(Number(id));
    }
    const removedIds = [...existingIds].filter(id => !submittedIds.has(id));
    // Do not erase medicine records that are still part of any bill, including past bills.
    for (const id of removedIds) {
        const [references] = await connection.execute(
            'SELECT id FROM tbl_bill_items WHERE consultation_medication_id = ? LIMIT 1 FOR UPDATE', [id]);
        if (references.length) throw new AppError('A billed additional medicine cannot be removed. Keep the medicine and edit its amount instead.', 409);
    }
    for (const id of removedIds) {
        await connection.execute('DELETE FROM tbl_medical_prescription_pricing_items WHERE pricing_id = ? AND consultation_medication_id = ?', [pricingId, id]);
        await connection.execute('DELETE FROM tbl_consultation_medications WHERE id = ? AND consultation_id = ?', [id, consultationId]);
    }
    for (const item of items) {
        let id = Number(item.consultation_medication_id) || null;
        if (id) {
            await connection.execute('UPDATE tbl_consultation_medications SET medicine_value = ? WHERE id = ? AND consultation_id = ?', [item.medicine_value, id, consultationId]);
        } else {
            const [insert] = await connection.execute(
                `INSERT INTO tbl_consultation_medications (consultation_id, medicine_type, medicine_value, remark, added_by_role)
                 VALUES (?, 'TEXT', ?, NULL, 'MEDICAL')`, [consultationId, item.medicine_value]);
            id = insert.insertId;
        }
        const [pricingRows] = await connection.execute('SELECT id FROM tbl_medical_prescription_pricing_items WHERE pricing_id = ? AND consultation_medication_id = ? FOR UPDATE', [pricingId, id]);
        if (pricingRows.length) {
            await connection.execute(
                `UPDATE tbl_medical_prescription_pricing_items SET medicine_value = ?, amount = ?, version = version + 1
                 WHERE id = ? AND pricing_id = ?`, [item.medicine_value, item.amount, pricingRows[0].id, pricingId]);
        } else {
            await connection.execute(
                `INSERT INTO tbl_medical_prescription_pricing_items
                 (pricing_id, consultation_medication_id, medicine_value, amount, dispense_status, version)
                 VALUES (?, ?, ?, ?, 'ACTIVE', 1)`, [pricingId, id, item.medicine_value, item.amount]);
        }
    }
};
module.exports = { saveAdditionalMedications };
