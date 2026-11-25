const { buildMedicalProductIdentityKey, hasSameMedicalProductIdentity } = require('../utils/medicalProductDedupe');

// Caller owns the transaction. Never restore inactive entries or rewrite rates.
const ensureManualMedicineCatalog = async (connection, medication) => {
    if (medication.medicine_type !== 'TEXT' || !(medication.is_manual_entry || medication.persist_manual_master)) return { action: 'NOT_MANUAL' };
    const { parseTextMedicineDisplayParts } = require('../controllers/v1/doctor/shared');
    const parsed = parseTextMedicineDisplayParts(medication.medicine_value);
    const name = String(medication.master_medicine_value || parsed.medicine_value || '').trim();
    if (!name) return { action: 'EMPTY' };
    const normalized = name.toLowerCase();
    const packing = String(medication.variant_value || parsed.variant_value || 'N/A').trim();
    const [names] = await connection.execute('SELECT id, is_active FROM master_text_medicines WHERE normalized_value = ? FOR UPDATE', [normalized]);
    if (names.length && Number(names[0].is_active) !== 1) return { action: 'INACTIVE_NAME' };
    // Check name-matched inactive products before creating even a missing name.
    const [prior] = await connection.execute('SELECT * FROM master_medical_products WHERE normalized_product_name = ? OR medicine_text_id = ?', [normalized, names[0]?.id || 0]);
    if (prior.length && prior.every(p => Number(p.is_active) !== 1)) return { action: 'INACTIVE_PRODUCTS' };
    await connection.execute(`INSERT INTO master_text_medicines (medicine_value, normalized_value, is_doctor_manual, is_active)
        VALUES (?, ?, 1, 1) ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)`, [name, normalized]);
    const [locked] = await connection.execute('SELECT id, is_active FROM master_text_medicines WHERE normalized_value = ? FOR UPDATE', [normalized]);
    const medicineId = locked[0].id;
    if (Number(locked[0].is_active) !== 1) return { action: 'INACTIVE_NAME' };
    const [products] = await connection.execute('SELECT * FROM master_medical_products WHERE normalized_product_name = ? OR medicine_text_id = ?', [normalized, medicineId]);
    const identity = { product_name: name, normalized_product_name: normalized, packing, size_or_weight: null };
    const existing = products.find(p => hasSameMedicalProductIdentity(p, identity));
    if (existing) {
        if (Number(existing.is_active) !== 1) return { action: 'INACTIVE_VARIANT' };
        if (existing.medicine_text_id == null) {
            await connection.execute('UPDATE master_medical_products SET medicine_text_id = ? WHERE id = ? AND medicine_text_id IS NULL AND is_active = 1', [medicineId, existing.id]);
            return { action: 'LINKED', medicineId };
        }
        return { action: 'EXISTING', medicineId };
    }
    if (products.length && products.every(p => Number(p.is_active) !== 1)) return { action: 'INACTIVE_PRODUCTS' };
    const quantity = Number(medication.quantity || parsed.quantity || 1);
    const price = medication.variant_unit_price != null ? Number(medication.variant_unit_price) : Number(medication.amount) / quantity;
    const rate = Number.isFinite(price) && price > 0 ? Number(price.toFixed(2)) : null;
    const [insert] = await connection.execute(`INSERT INTO master_medical_products
        (medicine_text_id, source_type, product_name, packing, mrp_rate, normalized_product_name, dedupe_key, is_active)
        VALUES (?, 'DOCTOR_MANUAL', ?, ?, ?, ?, ?, 1) ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)`,
    [medicineId, name.toUpperCase(), packing, rate, normalized, buildMedicalProductIdentityKey(identity)]);
    return { action: 'CREATED_PRODUCT', medicineId, productId: insert.insertId };
};
module.exports = { ensureManualMedicineCatalog };
