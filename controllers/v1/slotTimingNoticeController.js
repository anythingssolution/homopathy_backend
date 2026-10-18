const { query } = require('../../config/db');
const AppError = require('../../utils/AppError');
const asyncHandler = require('../../utils/asyncHandler');
const { getAppointmentPatientColumns, getAppointmentPatientJoin } = require('../../utils/patientFamily');
const { decorateTokenFields } = require('../../utils/tokenDisplay');
const { latestNotice, matchingUpdate, buildTimingDraft } = require('../../services/slotTimingNoticeService');

const getTimingChangeDraft = asyncHandler(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const [row] = await query(`SELECT a.appointment_id, a.fk_branch_id, a.fk_slot_id, a.is_active,
        a.status, a.reception_status, a.queue_status, a.current_token_number, a.original_token_number,
        a.current_token_number AS token_number, s.slot_name, s.start_time,
        DATE_FORMAT(a.appointment_date, '%Y-%m-%d') AS notice_date,
        DATE_FORMAT(a.appointment_date, '%Y-%m-%d') AS appointment_date,
        DATE_FORMAT(a.planned_start_at, '%Y-%m-%d %H:%i:%s') AS notice_planned_at,
        p.whatsapp_number, b.branch_name, ${getAppointmentPatientColumns()}
        FROM tbl_appointments a
        JOIN master_clinic_branches b ON b.id = a.fk_branch_id
        JOIN master_slots s ON s.id = a.fk_slot_id
        ${getAppointmentPatientJoin()}
        WHERE a.appointment_id = ? AND a.fk_branch_id = ? LIMIT 1`, [Number(req.params.appointment_id), req.selectedBranchId]);
    if (!row) throw new AppError('Appointment not found in selected branch', 404);
    const notice = await latestNotice(query, { branchId: row.fk_branch_id, slotId: row.fk_slot_id, appointmentDate: row.notice_date });
    const change = matchingUpdate(row, notice);
    if (!change) throw new AppError('No current timing update is available. Refresh the list.', 409);
    return res.status(200).json({ success: true, data: buildTimingDraft(decorateTokenFields(row), change) });
});
module.exports = { getTimingChangeDraft };
