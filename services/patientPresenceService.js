const { withTransaction } = require('../config/db');
const AppError = require('../utils/AppError');
const { logQueueEvent, recalculateLiveRuntimeProjection } = require('./liveQueueService');

const markPatientLeft = async ({ appointmentId, branchId, actorUserId, actorIp, reason }) => {
    if (!Number.isSafeInteger(Number(appointmentId)) || Number(appointmentId) <= 0) throw new AppError('Valid appointment is required', 400);
    if (!Number.isSafeInteger(Number(branchId)) || Number(branchId) <= 0) throw new AppError('Please select a branch', 400);
    const note = String(reason || '').trim();
    if (!note || note.length > 255) throw new AppError('Please enter a reason in 1–255 characters', 400);
    return withTransaction(async connection => {
        const [rows] = await connection.execute(`SELECT appointment_id, fk_branch_id, fk_slot_id,
            appointment_date, current_token_number, queue_status, status, is_active, checked_in_at,
            actual_started_at, actual_completed_at, (appointment_date = CURDATE()) AS is_today
            FROM tbl_appointments WHERE appointment_id = ? AND fk_branch_id = ? LIMIT 1 FOR UPDATE`, [appointmentId, branchId]);
        const current = rows[0];
        if (!current) throw new AppError('Appointment not found in selected branch', 404);
        if (Number(current.is_today) !== 1 || Number(current.is_active) !== 1 || ['Completed', 'Cancelled'].includes(current.status)) throw new AppError('Only today’s active, uncompleted appointment can be marked Patient left', 409);
        if (current.actual_started_at || current.actual_completed_at || !['BOOKED', 'WAITING', 'CHECKED_IN'].includes(current.queue_status)) throw new AppError('Consultation has started. Patient left cannot be used for an ongoing consultation.', 409);
        if (!current.checked_in_at) throw new AppError('Patient is already not checked in. Refresh the list.', 409);
        const [consultations] = await connection.execute('SELECT id FROM tbl_consultations WHERE appointment_id = ? LIMIT 1 FOR UPDATE', [appointmentId]);
        if (consultations.length) throw new AppError('A consultation record exists. Review it before changing patient presence.', 409);
        await connection.execute(`UPDATE tbl_appointments SET checked_in_at = NULL, arrival_sequence = NULL,
            actual_called_at = NULL, queue_status = 'BOOKED', not_available_at = NOW(),
            live_queue_assigned_position = NULL, live_queue_displacement_count = 0, live_queue_early_arrival = 0,
            last_queue_event_at = NOW(), updated_by = ?, updated_ip = ? WHERE appointment_id = ?`, [actorUserId, actorIp, appointmentId]);
        await connection.execute(`UPDATE tbl_live_queue_sessions SET
            current_token_number = CASE WHEN current_appointment_id = ? THEN NULL ELSE current_token_number END,
            current_appointment_id = CASE WHEN current_appointment_id = ? THEN NULL ELSE current_appointment_id END,
            updated_by = ? WHERE fk_branch_id = ? AND fk_slot_id = ? AND appointment_date = ?`,
        [appointmentId, appointmentId, actorUserId, current.fk_branch_id, current.fk_slot_id, current.appointment_date]);
        await logQueueEvent(connection, { appointmentId, branchId: current.fk_branch_id, slotId: current.fk_slot_id,
            appointmentDate: current.appointment_date, tokenNumber: current.current_token_number,
            eventType: 'PATIENT_LEFT', oldQueueStatus: current.queue_status, newQueueStatus: 'BOOKED', createdBy: actorUserId, meta: { reason: note } });
        await recalculateLiveRuntimeProjection(connection, { branchId: current.fk_branch_id, slotId: current.fk_slot_id,
            appointmentDate: current.appointment_date, actorUserId, actorIp });
        return { branchId: current.fk_branch_id, slotId: current.fk_slot_id, appointmentDate: current.appointment_date };
    });
};
module.exports = { markPatientLeft };
