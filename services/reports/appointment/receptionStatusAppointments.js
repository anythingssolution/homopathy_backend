const { buildAppointmentReportScope, query } = require('./shared');

const getReceptionStatusAppointmentsReport = async (filters) => {
    const { whereClause, params } = buildAppointmentReportScope(filters);

    return query(
        `SELECT
            a.reception_status,
            COUNT(a.appointment_id) AS total_appointments
         FROM tbl_appointments a
         ${whereClause}
         GROUP BY a.reception_status
         ORDER BY FIELD(a.reception_status, 'PENDING_AT_RECEPTION', 'APPROVED_BY_RECEPTION', 'REJECTED_BY_RECEPTION'), a.reception_status ASC`,
        params
    );
};

module.exports = getReceptionStatusAppointmentsReport;
