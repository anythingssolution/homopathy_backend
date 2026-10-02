const AppError = require('../utils/AppError');

const DISCOUNT_CATEGORIES = Object.freeze({
    CONSULTATION: 'CONSULTATION',
    MEDICINE: 'MEDICINE',
    TEST: 'TEST',
    COURIER: 'COURIER',
});
const DISCOUNT_REASONS = new Set(['DOCTOR_APPROVED', 'OTHER']);

const toMoney = (value, field = 'discount amount') => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) {
        throw new AppError(`${field} must be a valid non-negative number`, 400);
    }
    return Number(parsed.toFixed(2));
};

const normalizeDiscounts = (value) => {
    if (value === undefined || value === null) return null;
    if (!Array.isArray(value)) throw new AppError('discounts must be an array', 400);

    const seen = new Set();
    return value.map((entry, index) => {
        const category = String(entry?.category || '').trim().toUpperCase();
        if (!Object.values(DISCOUNT_CATEGORIES).includes(category)) {
            throw new AppError(`discounts[${index}].category is invalid`, 400);
        }
        if (seen.has(category)) throw new AppError(`Only one ${category.toLowerCase()} discount is allowed`, 400);
        seen.add(category);

        const amount = toMoney(entry?.amount, `discounts[${index}].amount`);
        const reasonCode = String(entry?.reason_code || entry?.reason || '').trim().toUpperCase();
        const reasonNote = entry?.reason_note || entry?.note
            ? String(entry.reason_note || entry.note).trim().slice(0, 255)
            : null;

        if (amount > 0 && !reasonCode) {
            throw new AppError(`discounts[${index}].reason_code is required`, 400);
        }
        if (amount > 0 && !DISCOUNT_REASONS.has(reasonCode)) {
            throw new AppError(`discounts[${index}].reason_code must be DOCTOR_APPROVED or OTHER`, 400);
        }
        if (amount > 0 && reasonCode === 'OTHER' && !reasonNote) {
            throw new AppError(`discounts[${index}].reason_note is required for OTHER`, 400);
        }

        return { category, amount, reason_code: reasonCode, reason_note: reasonNote };
    }).filter((entry) => entry.amount > 0);
};

const parseStoredDiscounts = (value) => {
    if (!value) return [];
    try {
        const parsed = typeof value === 'string' ? JSON.parse(value) : value;
        return normalizeDiscounts(parsed) || [];
    } catch (error) {
        if (error instanceof AppError) throw error;
        throw new AppError('Stored billing discount data is invalid', 500);
    }
};

const getCategoryGross = async (connection, bill) => {
    if (bill.bill_type === 'CONSULTATION') {
        return {
            CONSULTATION: toMoney(bill.gross_amount ?? bill.total_amount),
            MEDICINE: 0,
            TEST: 0,
            COURIER: 0,
        };
    }

    const [rows] = await connection.execute(
        `SELECT
            COALESCE(SUM(CASE
                WHEN UPPER(COALESCE(item_type, '')) = 'TEST' THEN 0
                WHEN LOWER(COALESCE(item_name, '')) = 'courier charge' THEN 0
                ELSE amount END), 0) AS medicine_gross,
            COALESCE(SUM(CASE WHEN UPPER(COALESCE(item_type, '')) = 'TEST' THEN amount ELSE 0 END), 0) AS test_gross,
            COALESCE(SUM(CASE WHEN LOWER(COALESCE(item_name, '')) = 'courier charge' THEN amount ELSE 0 END), 0) AS courier_gross
         FROM tbl_bill_items
         WHERE bill_id = ?`,
        [bill.id]
    );

    return {
        CONSULTATION: 0,
        MEDICINE: toMoney(rows[0]?.medicine_gross || 0),
        TEST: toMoney(rows[0]?.test_gross || 0),
        COURIER: toMoney(rows[0]?.courier_gross || 0),
    };
};

const setReceptionistConsultationFee = async ({ connection, billId, amount, actorUserId }) => {
    if (!['number', 'string'].includes(typeof amount) || String(amount).trim() === '') {
        throw new AppError('consultation_fee must be a valid non-negative number', 400);
    }
    const fee = toMoney(amount, 'consultation_fee');
    if (fee > 99999999.99) throw new AppError('consultation_fee exceeds the supported amount', 400);
    const [rows] = await connection.execute(
        `SELECT id, bill_type, status, gross_amount, paid_amount
         FROM tbl_bills WHERE id = ? LIMIT 1 FOR UPDATE`,
        [billId]
    );
    const bill = rows[0];
    if (!bill) throw new AppError('Bill not found', 404);
    if (bill.bill_type !== 'CONSULTATION' || bill.status !== 'ACTIVE') {
        throw new AppError('Fee can be set only for an active consultation bill', 409);
    }
    if (Number(bill.paid_amount) > 0) {
        if (fee !== Number(bill.gross_amount)) {
            throw new AppError('Consultation fee cannot be changed after payment collection', 409);
        }
        return;
    }
    await connection.execute(
        'UPDATE tbl_bills SET gross_amount = ?, updated_by = ? WHERE id = ?',
        [fee, actorUserId, billId]
    );
};

const replaceBillDiscounts = async ({ connection, billId, discounts, actorUserId }) => {
    const normalized = normalizeDiscounts(discounts);
    if (normalized === null) return null;

    const [billRows] = await connection.execute(
        `SELECT id, bill_type, appointment_id, gross_amount, total_amount, paid_amount, status
         FROM tbl_bills WHERE id = ? LIMIT 1 FOR UPDATE`,
        [billId]
    );
    if (billRows.length === 0) throw new AppError('Bill not found', 404);
    const bill = billRows[0];
    if (bill.status !== 'ACTIVE') throw new AppError('Discount can be applied only to an active bill', 409);

    const grossByCategory = await getCategoryGross(connection, bill);
    for (const discount of normalized) {
        if (discount.amount > grossByCategory[discount.category]) {
            throw new AppError(`${discount.category.toLowerCase()} discount cannot exceed ₹${grossByCategory[discount.category].toFixed(2)}`, 400);
        }
    }

    const grossAmount = bill.bill_type === 'CONSULTATION'
        ? grossByCategory.CONSULTATION
        : Number((grossByCategory.MEDICINE + grossByCategory.TEST + grossByCategory.COURIER).toFixed(2));
    const discountAmount = Number(normalized.reduce((sum, item) => sum + item.amount, 0).toFixed(2));
    const netAmount = Number((grossAmount - discountAmount).toFixed(2));
    const paidAmount = toMoney(bill.paid_amount || 0, 'paid amount');
    if (netAmount < paidAmount) {
        throw new AppError('Discount cannot make the bill total lower than the amount already received', 409);
    }

    await connection.execute(
        `UPDATE tbl_bill_discounts
         SET status = 'VOID', voided_by = ?, voided_at = NOW(), void_reason = 'Replaced by billing update'
         WHERE bill_id = ? AND status = 'ACTIVE'`,
        [actorUserId, billId]
    );

    for (const discount of normalized) {
        await connection.execute(
            `INSERT INTO tbl_bill_discounts
             (bill_id, discount_category, discount_type, discount_value, discount_amount,
              reason_code, reason_note, status, created_by)
             VALUES (?, ?, 'AMOUNT', ?, ?, ?, ?, 'ACTIVE', ?)`,
            [billId, discount.category, discount.amount, discount.amount, discount.reason_code, discount.reason_note, actorUserId]
        );
    }

    const pendingAmount = Number((netAmount - paidAmount).toFixed(2));
    const paymentStatus = pendingAmount <= 0 ? 'PAID' : paidAmount > 0 ? 'PARTIAL' : 'UNPAID';
    await connection.execute(
        `UPDATE tbl_bills
         SET gross_amount = ?, discount_amount = ?, total_amount = ?, pending_amount = ?, payment_status = ?, updated_by = ?
         WHERE id = ?`,
        [grossAmount, discountAmount, netAmount, pendingAmount, paymentStatus, actorUserId, billId]
    );

    if (bill.bill_type === 'CONSULTATION' && bill.appointment_id) {
        await connection.execute(
            `UPDATE tbl_appointments
             SET consultation_payment_status = ?, updated_by = ?
             WHERE appointment_id = ?`,
            [paymentStatus === 'PAID' ? 'PAID' : 'UNPAID', actorUserId, bill.appointment_id]
        );
    }

    return { gross_amount: grossAmount, discount_amount: discountAmount, total_amount: netAmount, pending_amount: pendingAmount, payment_status: paymentStatus };
};

const listBillDiscounts = async (billId) => {
    const { query } = require('../config/db');
    return query(
        `SELECT id AS discount_id, bill_id, discount_category AS category, discount_type,
                discount_value, discount_amount AS amount, reason_code, reason_note,
                created_by, created_at
         FROM tbl_bill_discounts
         WHERE bill_id = ? AND status = 'ACTIVE'
         ORDER BY id ASC`,
        [billId]
    );
};

module.exports = {
    setReceptionistConsultationFee,
    DISCOUNT_CATEGORIES,
    normalizeDiscounts,
    parseStoredDiscounts,
    replaceBillDiscounts,
    listBillDiscounts,
};
