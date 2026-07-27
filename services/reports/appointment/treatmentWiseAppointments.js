const { buildAppointmentReportScope, query } = require('./shared');

const getTreatmentWiseAppointmentsReport = async (filters) => {
    const { whereClause, params } = buildAppointmentReportScope(filters);

    return query(
        `SELECT
            t.id AS treatment_id,
            t.treatment_name,
            COUNT(a.appointment_id) AS total_appointments,
            SUM(CASE WHEN a.status = 'Pending' THEN 1 ELSE 0 END) AS pending_appointments,
            SUM(CASE WHEN a.status = 'Confirmed' THEN 1 ELSE 0 END) AS confirmed_appointments,
            SUM(CASE WHEN a.status = 'Completed' THEN 1 ELSE 0 END) AS completed_appointments,
            SUM(CASE WHEN a.status = 'Cancelled' THEN 1 ELSE 0 END) AS cancelled_appointments
         FROM tbl_appointments a
         JOIN master_treatments t ON t.id = a.fk_treatment_id
         ${whereClause}
         GROUP BY t.id, t.treatment_name
         ORDER BY total_appointments DESC, t.treatment_name ASC`,
        params
    );
};

module.exports = getTreatmentWiseAppointmentsReport;
