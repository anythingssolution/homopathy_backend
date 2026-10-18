const AppError = require('../utils/AppError');

const parseJson = value => {
    try { return typeof value === 'string' ? JSON.parse(value) : value || {}; } catch { return {}; }
};
const contextParams = context => [context.branchId, context.slotId, context.appointmentDate];
const isEligible = row => Number(row.is_active) === 1
    && !['Cancelled', 'Completed'].includes(row.status)
    && row.reception_status !== 'REJECTED_BY_RECEPTION'
    && !['CANCELLED', 'COMPLETED'].includes(row.queue_status);

const snapshotTimingAppointments = async (connection, context) => {
    const [rows] = await connection.execute(
        `SELECT appointment_id, is_active, status, reception_status, queue_status,
                DATE_FORMAT(planned_start_at, '%Y-%m-%d %H:%i:%s') AS planned_start_at
         FROM tbl_appointments
         WHERE fk_branch_id = ? AND fk_slot_id = ? AND appointment_date = ? AND is_active = 1
         FOR UPDATE`, contextParams(context));
    return rows.filter(isEligible);
};

// Add patient snapshots to the audit row written by the existing successful timing change.
// This runs in that same transaction; no separate notification or external send can affect the queue.
const recordTimingNotice = async (connection, { context, before, oldStart, newStart }) => {
    if (String(oldStart) === String(newStart)) return;
    const after = await snapshotTimingAppointments(connection, context);
    const oldById = new Map(before.map(row => [Number(row.appointment_id), row]));
    const updates = after.flatMap(row => {
        const old = oldById.get(Number(row.appointment_id));
        if (!old || !row.planned_start_at || old.planned_start_at === row.planned_start_at) return [];
        return [{ appointment_id: Number(row.appointment_id), old_planned_at: old.planned_start_at || null, new_planned_at: row.planned_start_at }];
    });
    const [audits] = await connection.execute(
        `SELECT id, new_data_json FROM tbl_doctor_slot_time_override_audit_logs
         WHERE fk_branch_id = ? AND fk_slot_id = ? AND appointment_date = ? ORDER BY id DESC LIMIT 1 FOR UPDATE`, contextParams(context));
    if (!audits[0]) throw new AppError('Timing change audit was not recorded', 500);
    const data = { ...parseJson(audits[0].new_data_json), patient_timing_notice: { version: 1, old_slot_start: oldStart, new_slot_start: newStart, updates } };
    await connection.execute('UPDATE tbl_doctor_slot_time_override_audit_logs SET new_data_json = ? WHERE id = ?', [JSON.stringify(data), audits[0].id]);
};

const latestNotice = async (query, context) => {
    const rows = await query(
        `SELECT id, new_data_json FROM tbl_doctor_slot_time_override_audit_logs
         WHERE fk_branch_id = ? AND fk_slot_id = ? AND appointment_date = ? AND JSON_EXTRACT(new_data_json, '$.patient_timing_notice') IS NOT NULL ORDER BY id DESC LIMIT 1`, contextParams(context));
    const record = rows[0];
    return record ? { ...parseJson(record.new_data_json).patient_timing_notice, id: Number(record.id) } : null;
};
const matchingUpdate = (row, notice) => {
    if (!isEligible(row) || !notice || notice.version !== 1) return null;
    const update = notice.updates?.find(item => Number(item.appointment_id) === Number(row.appointment_id));
    // A reschedule, transfer, or later queue re-plan must never share an obsolete time.
    const current = row.notice_planned_at;
    if (!update || !current || current !== update.new_planned_at) return null;
    return { ...update, change_id: notice.id, old_slot_start: notice.old_slot_start, new_slot_start: notice.new_slot_start };
};
const attachTimingNotices = async (query, appointments) => {
    if (!appointments.length) return appointments;
    const groups = new Map();
    appointments.forEach(row => {
        const date = row.notice_date;
        const key = `${row.fk_branch_id}:${row.fk_slot_id}:${date}`;
        if (!groups.has(key)) groups.set(key, { branchId: row.fk_branch_id, slotId: row.fk_slot_id, appointmentDate: date });
    });
    const notices = new Map(await Promise.all([...groups].map(async ([key, context]) => [key, await latestNotice(query, context)])));
    return appointments.map(row => {
        const date = row.notice_date;
        return { ...row, timing_change: matchingUpdate(row, notices.get(`${row.fk_branch_id}:${row.fk_slot_id}:${date}`)) };
    });
};
const normalizeWhatsAppPhone = value => {
    let digits = String(value || '').replace(/\D/g, '');
    if (digits.startsWith('00')) digits = digits.slice(2);
    if (/^0[6-9]\d{9}$/.test(digits)) digits = digits.slice(1);
    if (/^[6-9]\d{9}$/.test(digits)) digits = `91${digits}`;
    return /^[1-9]\d{10,14}$/.test(digits) ? digits : null;
};
const formatClock = value => {
    const time = String(value || '').split(/[ T]/).pop();
    const [h, m] = time.split(':').map(Number);
    return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
};
const minutes = value => {
    const [h, m, s = 0] = String(value).split(/[ T]/).pop().split(':').map(Number);
    return h * 60 + m + s / 60;
};
const buildTimingDraft = (row, change) => {
    const phone = normalizeWhatsAppPhone(row.whatsapp_number || row.patient_mobile_no);
    const delta = minutes(change.new_slot_start) - minutes(change.old_slot_start);
    const magnitude = Math.abs(delta);
    const offset = `${Math.floor(magnitude / 60) ? `${Math.floor(magnitude / 60)} ghanta ` : ''}${magnitude % 60 ? `${Math.round(magnitude % 60)} minute ` : ''}`.trim();
    const date = row.notice_date.split('-').reverse().join('/');
    const oldTime = change.old_planned_at ? formatClock(change.old_planned_at) : null;
    const newTime = formatClock(change.new_planned_at);
    const message = `Namaste ${row.patient_full_name} ji,\nDr. Trivedi Homeopathic Clinic se aapki appointment timing ka update hai.\n\n${date} ko ${row.branch_name} mein doctor ka consultation session ${offset} ${delta > 0 ? 'baad' : 'pehle'} shuru hoga.\n${oldTime ? `Aapka planned consultation time ${oldTime} se badalkar ${newTime} ho gaya hai.` : `Aapka updated planned consultation time ${newTime} hai.`}\nToken: ${row.display_token_display || row.current_token_number || row.token_number}\n\nKripya updated timing ke anusaar clinic padharein. Yeh anumaanit samay hai; consultation ki pragati ke anusaar thoda antar ho sakta hai.\nDhanyavaad.`;
    return { change_id: change.change_id, appointment_id: Number(row.appointment_id), patient_name: row.patient_full_name, contact_name: row.primary_patient_full_name, is_family_member_booking: Boolean(row.is_family_member_booking), phone, date, branch_name: row.branch_name, old_time: oldTime, new_time: newTime, token: row.display_token_display || row.current_token_number || row.token_number, message, whatsapp_url: phone ? `https://wa.me/${phone}?text=${encodeURIComponent(message)}` : null };
};
module.exports = { snapshotTimingAppointments, recordTimingNotice, latestNotice, matchingUpdate, attachTimingNotices, normalizeWhatsAppPhone, buildTimingDraft };
