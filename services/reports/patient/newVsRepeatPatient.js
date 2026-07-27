const { buildPatientAppointmentScope, query } = require('./shared');

const getNewVsRepeatPatientReport = async (filters) => {
    const { whereClause, params } = buildPatientAppointmentScope(filters);

    return query(
        `SELECT
            CASE
                WHEN previous_a.appointment_id IS NULL THEN 'NEW'
                ELSE 'REPEAT'
            END AS patient_visit_type,
            COUNT(DISTINCT a.appointment_id) AS total_appointments,
            COUNT(DISTINCT COALESCE(a.booking_subject_key, CONCAT('SELF:', a.fk_patient_id))) AS unique_booking_subjects
         FROM tbl_appointments a
         LEFT JOIN tbl_appointments previous_a
           ON previous_a.booking_subject_key = a.booking_subject_key
          AND previous_a.appointment_date < a.appointment_date
          AND previous_a.is_active = 1
         ${whereClause}
         GROUP BY CASE WHEN previous_a.appointment_id IS NULL THEN 'NEW' ELSE 'REPEAT' END
         ORDER BY FIELD(patient_visit_type, 'NEW', 'REPEAT')`,
        params
    );
};

module.exports = getNewVsRepeatPatientReport;
