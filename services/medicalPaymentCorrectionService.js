const AppError = require('../utils/AppError');

const cents = (value) => {
    const amount = Number(value);
    if (!Number.isFinite(amount) || amount < 0) throw new AppError('Received amount must be a valid non-negative number', 400);
    return Math.round(amount * 100);
};

// Correct original receipts without turning the correction into a new collection.
const planReceiptCorrection = ({ payments, total, received, expectedPaid, paid }) => {
    const target = cents(received);
    if (cents(expectedPaid) !== cents(paid)) throw new AppError('Payment changed. Please reopen Edit and try again.', 409);
    if (target > cents(total)) throw new AppError('Received amount cannot exceed the bill total', 400);
    if (payments.reduce((sum, row) => sum + cents(row.amount), 0) !== cents(paid)) {
        throw new AppError('Receipt total does not match the bill. Please review its payment history.', 409);
    }
    const rows = payments.map(row => ({ ...row, nextAmount: cents(row.amount) }));
    let difference = target - cents(paid);
    const editable = rows.filter(row => row.allocation_kind === 'CURRENT'
        && (!row.settlement_source_bill_id || Number(row.settlement_source_bill_id) === Number(row.bill_id)));
    if (difference > 0) {
        if (!editable.length) throw new AppError('No original receipt to correct. Record a new payment through Collect Dues.', 409);
        editable[editable.length - 1].nextAmount += difference;
    } else {
        for (const row of [...editable].reverse()) {
            const reduction = Math.min(row.nextAmount, -difference);
            row.nextAmount -= reduction;
            difference += reduction;
        }
        if (difference < 0) throw new AppError('Received amount cannot be lower than later dues payments. Correct those receipts separately.', 409);
    }
    let remaining = cents(total);
    return rows.map(row => {
        const before = remaining;
        remaining -= row.nextAmount;
        return { ...row, nextAmount: row.nextAmount / 100, pendingBefore: before / 100, pendingAfter: remaining / 100 };
    });
};

const correctMedicalReceivedAmount = async ({ connection, billId, received, expectedPaid, userId, requestKey }) => {
    const [[bill]] = await connection.execute('SELECT * FROM tbl_bills WHERE id = ? FOR UPDATE', [billId]);
    if (!bill || bill.bill_type !== 'MEDICATION' || bill.status !== 'ACTIVE') throw new AppError('Active medicine bill not found', 409);
    const [payments] = await connection.execute("SELECT * FROM tbl_bill_payments WHERE bill_id = ? AND status = 'SUCCESS' ORDER BY collected_at, id FOR UPDATE", [billId]);
    const plan = planReceiptCorrection({ payments, total: bill.total_amount, received, expectedPaid, paid: bill.paid_amount });
    const changed = plan.some(row => cents(row.amount) !== cents(row.nextAmount));
    if (changed) {
        await connection.execute(`INSERT INTO tbl_medical_payment_corrections
            (bill_id, old_paid_amount, new_paid_amount, receipt_snapshot, corrected_by, request_key)
            VALUES (?, ?, ?, ?, ?, ?)`, [billId, bill.paid_amount, received, JSON.stringify(payments), userId, requestKey]);
    }
    for (const row of plan) {
        await connection.execute('UPDATE tbl_bill_payments SET amount = ?, pending_before = ?, pending_after = ? WHERE id = ?',
            [row.nextAmount, row.pendingBefore, row.pendingAfter, row.id]);
    }
    const paid = cents(received) / 100;
    const pending = (cents(bill.total_amount) - cents(received)) / 100;
    const status = pending === 0 ? 'PAID' : paid > 0 ? 'PARTIAL' : 'UNPAID';
    await connection.execute('UPDATE tbl_bills SET paid_amount = ?, pending_amount = ?, payment_status = ?, updated_by = ? WHERE id = ?',
        [paid, pending, status, userId, billId]);
};

module.exports = { planReceiptCorrection, correctMedicalReceivedAmount };
