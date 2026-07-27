const { query } = require('./shared');

const getFollowupDueReport = async ({ fromDate, toDate, branchId }) => {
    const conditions = ['pf.due_date >= ?', 'pf.due_date <= ?'];
    const params = [fromDate, toDate];

    if (branchId) {
        conditions.push('pa.fk_branch_id = ?');
        params.push(branchId);
    }

    return query(
        `SELECT
            pf.id AS followup_id,
            pf.parent_appointment_id,
            pf.due_date,
            pf.status,
            COALESCE(fm.full_name, p.full_name) AS patient_full_name,
            p.mobile_no AS patient_mobile_no,
            b.branch_name,
            t.treatment_name,
            pa.appointment_date AS parent_appointment_date,
            pf.created_at
         FROM tbl_pending_followups pf
         JOIN tbl_appointments pa ON pa.appointment_id = pf.parent_appointment_id
         JOIN master_users p ON p.id = pf.fk_patient_id
         LEFT JOIN tbl_patient_family_members fm ON fm.id = pf.fk_family_member_id
         JOIN master_clinic_branches b ON b.id = pa.fk_branch_id
         JOIN master_treatments t ON t.id = pa.fk_treatment_id
         WHERE ${conditions.join(' AND ')}
         ORDER BY pf.due_date ASC, pf.id ASC`,
        params
    );
};

module.exports = getFollowupDueReport;
