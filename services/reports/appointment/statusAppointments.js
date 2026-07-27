const { buildAppointmentReportScope, query } = require('./shared');

const getStatusAppointmentsReport = async (filters) => {
    const { whereClause, params } = buildAppointmentReportScope(filters);

    return query(
        `SELECT
            a.status,
            COUNT(a.appointment_id) AS total_appointments
         FROM tbl_appointments a
         ${whereClause}
         GROUP BY a.status
         ORDER BY FIELD(a.status, 'Pending', 'Confirmed', 'Completed', 'Cancelled'), a.status ASC`,
        params
    );
};

module.exports = getStatusAppointmentsReport;
