const { buildPatientAppointmentScope, query } = require('./shared');

const getPatientAppointmentHistoryReport = async (filters) => {
    const { whereClause, params } = buildPatientAppointmentScope(filters);

    return query(
        `SELECT
            a.appointment_id,
            a.auid,
            a.appointment_date,
            a.current_token_number AS token_number,
            COALESCE(fm.full_name, p.full_name) AS patient_full_name,
            p.mobile_no AS patient_mobile_no,
            a.booked_for_type,
            fm.relationship AS family_member_relationship,
            b.branch_name,
            s.slot_name,
            t.treatment_name,
            a.status,
            a.reception_status,
            a.queue_status,
            a.created_at
         FROM tbl_appointments a
         JOIN master_users p ON p.id = a.fk_patient_id
         LEFT JOIN tbl_patient_family_members fm ON fm.id = a.fk_patient_family_member_id
         JOIN master_clinic_branches b ON b.id = a.fk_branch_id
         JOIN master_slots s ON s.id = a.fk_slot_id
         JOIN master_treatments t ON t.id = a.fk_treatment_id
         ${whereClause}
         ORDER BY a.appointment_date DESC, a.current_token_number ASC`,
        params
    );
};

module.exports = getPatientAppointmentHistoryReport;
