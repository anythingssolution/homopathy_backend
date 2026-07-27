const { buildAppointmentReportScope, query } = require('./shared');

const getDateWiseAppointmentsReport = async (filters) => {
    const { whereClause, params } = buildAppointmentReportScope(filters);

    return query(
        `SELECT
            a.appointment_date,
            COUNT(a.appointment_id) AS total_appointments,
            SUM(CASE WHEN a.status = 'Pending' THEN 1 ELSE 0 END) AS pending_appointments,
            SUM(CASE WHEN a.status = 'Confirmed' THEN 1 ELSE 0 END) AS confirmed_appointments,
            SUM(CASE WHEN a.status = 'Completed' THEN 1 ELSE 0 END) AS completed_appointments,
            SUM(CASE WHEN a.status = 'Cancelled' THEN 1 ELSE 0 END) AS cancelled_appointments
         FROM tbl_appointments a
         ${whereClause}
         GROUP BY a.appointment_date
         ORDER BY a.appointment_date ASC`,
        params
    );
};

module.exports = getDateWiseAppointmentsReport;
