const { buildAppointmentReportScope, query } = require('./shared');

const getBookingSubjectAppointmentsReport = async (filters) => {
    const { whereClause, params } = buildAppointmentReportScope(filters);

    return query(
        `SELECT
            a.booked_for_type,
            COUNT(a.appointment_id) AS total_appointments
         FROM tbl_appointments a
         ${whereClause}
         GROUP BY a.booked_for_type
         ORDER BY FIELD(a.booked_for_type, 'SELF', 'FAMILY_MEMBER'), a.booked_for_type ASC`,
        params
    );
};

module.exports = getBookingSubjectAppointmentsReport;
