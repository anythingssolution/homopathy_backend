const { buildPatientAppointmentScope, query } = require('./shared');

const getFamilyMemberPatientReport = async (filters) => {
    const { whereClause, params } = buildPatientAppointmentScope(filters);

    return query(
        `SELECT
            fm.id AS family_member_id,
            fm.full_name AS family_member_full_name,
            fm.relationship,
            fm.age,
            fm.gender,
            p.id AS primary_patient_id,
            p.full_name AS primary_patient_full_name,
            p.mobile_no AS primary_patient_mobile_no,
            COUNT(a.appointment_id) AS total_appointments,
            MAX(a.appointment_date) AS last_appointment_date
         FROM tbl_appointments a
         JOIN tbl_patient_family_members fm ON fm.id = a.fk_patient_family_member_id
         JOIN master_users p ON p.id = a.fk_patient_id
         ${whereClause}
           AND a.booked_for_type = 'FAMILY_MEMBER'
         GROUP BY fm.id, fm.full_name, fm.relationship, fm.age, fm.gender, p.id, p.full_name, p.mobile_no
         ORDER BY total_appointments DESC, family_member_full_name ASC`,
        params
    );
};

module.exports = getFamilyMemberPatientReport;
