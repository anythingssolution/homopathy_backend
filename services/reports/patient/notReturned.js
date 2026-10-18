const { query } = require('../shared');
const AppError = require('../../../utils/AppError');

const clinicToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const monthsBefore = (date, months) => {
    const [year, month, day] = date.split('-').map(Number);
    const first = new Date(Date.UTC(year, month - 1 - months, 1));
    const lastDay = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
    return new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), Math.min(day, lastDay))).toISOString().slice(0, 10);
};
const daysBetween = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);

const buildNotReturnedReport = (rows, asOf) => {
    const cutoffs = [1, 2, 3].map(months => monthsBefore(asOf, months));
    const patients = new Map();
    for (const row of rows) {
        const key = row.family_member_id ? `FM:${row.family_member_id}` : `PAT:${row.fk_patient_id}`;
        const previous = patients.get(key);
        if (!previous || row.last_visit_date > previous.last_visit_date || (row.last_visit_date === previous.last_visit_date && Number(row.consultation_id) > Number(previous.consultation_id))) patients.set(key, row);
    }
    const result = [...patients.entries()].filter(([,row]) => row.last_visit_date <= cutoffs[0]).map(([key, row]) => ({
        ...row,
        subject_key: key,
        bucket: row.last_visit_date <= cutoffs[2] ? '3_plus' : row.last_visit_date <= cutoffs[1] ? '2_3' : '1_2',
        days_since_visit: daysBetween(row.last_visit_date, asOf),
        overdue_days: !row.follow_up_chain_closed && row.due_date && row.due_date < asOf ? daysBetween(row.due_date, asOf) : 0,
    })).sort((a,b) => b.overdue_days - a.overdue_days || b.days_since_visit - a.days_since_visit || a.patient_full_name.localeCompare(b.patient_full_name));
    return { as_of: asOf, rows: result };
};

const getNotReturnedReport = async ({ branchId }) => {
    if (!Number.isInteger(Number(branchId)) || Number(branchId) <= 0) throw new AppError('Please select a branch', 400);
    const today = clinicToday();
    const rows = await query(`SELECT
        a.fk_patient_id, a.fk_patient_family_member_id AS family_member_id,
        p.uuid AS patient_uuid, COALESCE(fm.full_name,p.full_name) AS patient_full_name,
        p.mobile_no AS patient_mobile_no, fm.relationship AS family_member_relationship,
        c.id AS consultation_id, a.appointment_id, t.treatment_name, c.disease, c.diagnosis,
        c.workflow_status, c.follow_up_chain_closed,
        DATE_FORMAT(a.appointment_date,'%Y-%m-%d') AS last_visit_date,
        (SELECT DATE_FORMAT(MIN(pf.due_date),'%Y-%m-%d') FROM tbl_pending_followups pf
            WHERE pf.parent_appointment_id=a.appointment_id AND pf.status IN ('PENDING','NOTIFIED','CONFIRMED_BOOKED')) AS due_date,
        (SELECT DATE_FORMAT(MIN(na.appointment_date),'%Y-%m-%d') FROM tbl_appointments na
            WHERE na.fk_patient_id=a.fk_patient_id AND na.fk_patient_family_member_id <=> a.fk_patient_family_member_id
              AND na.fk_branch_id=a.fk_branch_id AND na.appointment_date>=? AND na.is_active=1
              AND na.status NOT IN ('Cancelled','Completed')
              AND COALESCE(na.reception_status,'') <> 'REJECTED_BY_RECEPTION'
              AND COALESCE(na.queue_status,'') <> 'CANCELLED') AS next_appointment,
        (SELECT DATE_FORMAT(MAX(mb.created_at),'%Y-%m-%d') FROM tbl_bills mb
            LEFT JOIN tbl_consultations mc ON mc.id=mb.consultation_id
            LEFT JOIN tbl_appointments ma ON ma.appointment_id=COALESCE(mb.appointment_id,mc.appointment_id)
            WHERE mb.patient_id=a.fk_patient_id AND mb.fk_branch_id=a.fk_branch_id
              AND ma.fk_patient_family_member_id <=> a.fk_patient_family_member_id
              AND mb.bill_type='MEDICATION' AND mb.status='ACTIVE' AND mb.appointment_id IS NULL
              AND DATE(mb.created_at)>=a.appointment_date AND DATE(mb.created_at)<=?) AS last_medicine_date
        FROM tbl_consultations c
        JOIN tbl_appointments a ON a.appointment_id=c.appointment_id
        JOIN master_users p ON p.id=a.fk_patient_id
        LEFT JOIN tbl_patient_family_members fm ON fm.id=a.fk_patient_family_member_id
        JOIN master_treatments t ON t.id=a.fk_treatment_id
        WHERE a.fk_branch_id=? AND a.is_active=1 AND a.status='Completed'
          AND p.is_active=1 AND (fm.id IS NULL OR fm.is_active=1)
          AND a.appointment_date<=?
          AND NOT EXISTS (SELECT 1 FROM tbl_appointments newer
              JOIN tbl_consultations nc ON nc.appointment_id=newer.appointment_id
              WHERE newer.fk_patient_id=a.fk_patient_id AND newer.fk_branch_id=a.fk_branch_id
                AND newer.fk_patient_family_member_id <=> a.fk_patient_family_member_id
                AND newer.is_active=1 AND newer.status='Completed' AND newer.appointment_date<=?
                AND (newer.appointment_date>a.appointment_date OR (newer.appointment_date=a.appointment_date AND nc.id>c.id)))`,
    [today, today, branchId, today, today]);
    return buildNotReturnedReport(rows, today);
};

module.exports = { getNotReturnedReport, buildNotReturnedReport, monthsBefore };
