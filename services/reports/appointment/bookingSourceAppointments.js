const { buildAppointmentReportScope, query } = require('./shared');

const getBookingSourceAppointmentsReport = async (filters) => {
    const { whereClause, params } = buildAppointmentReportScope(filters);

    return query(
        `SELECT
            a.booked_by_type,
            COUNT(a.appointment_id) AS total_appointments
         FROM tbl_appointments a
         ${whereClause}
         GROUP BY a.booked_by_type
         ORDER BY FIELD(a.booked_by_type, 'SELF', 'RECEPTIONIST'), a.booked_by_type ASC`,
        params
    );
};

module.exports = getBookingSourceAppointmentsReport;
