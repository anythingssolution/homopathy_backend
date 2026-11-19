const AppError = require('../utils/AppError');
async function cancelPendingDispense(connection, { consultationId, branchId, actorId, deliveryMode, reason }) {
    if (!['HAND_DELIVERY', 'COURIER'].includes(deliveryMode)) throw new AppError('Select Hand Delivery or Courier', 400);
    if (typeof reason !== 'string' || !reason.trim() || reason.trim().length > 1000) throw new AppError('Enter a cancellation reason (maximum 1000 characters)', 400);
    // Same consultation-first lock order as pricing and processing.
    const [[consultation]] = await connection.execute(
        'SELECT c.id, c.workflow_status, a.fk_branch_id FROM tbl_consultations c JOIN tbl_appointments a ON a.appointment_id = c.appointment_id WHERE c.id = ? FOR UPDATE', [consultationId]);
    if (!consultation || (branchId && Number(branchId) !== Number(consultation.fk_branch_id))) throw new AppError('Prescription not found for selected branch', 404);
    if (consultation.workflow_status !== 'READY_FOR_MEDICAL') throw new AppError('Only pending, undispensed prescriptions can be cancelled. Refresh the list.', 409);
    const [bills] = await connection.execute("SELECT id, paid_amount FROM tbl_bills WHERE consultation_id = ? AND bill_type = 'MEDICATION' AND status = 'ACTIVE' FOR UPDATE", [consultationId]);
    if (bills.some(bill => Number(bill.paid_amount) > 0)) throw new AppError('This prescription has a recorded payment and cannot be cancelled here', 409);
    const cancellation = { delivery_mode: deliveryMode, reason: reason.trim(), cancelled_by: actorId, cancelled_at: new Date().toISOString() };
    await connection.execute("UPDATE tbl_consultations SET workflow_status = 'DISPENSE_CANCELLED', dispense_cancellation = ? WHERE id = ?", [JSON.stringify(cancellation), consultationId]);
    // Any previously saved unpaid draft bill must stop contributing to pending dues/revenue.
    for (const bill of bills) await connection.execute("UPDATE tbl_bills SET status = 'CANCELLED' WHERE id = ?", [bill.id]);
    return cancellation;
}
module.exports = { cancelPendingDispense };
