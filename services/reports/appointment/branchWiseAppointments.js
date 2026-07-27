const { buildAppointmentReportScope, query } = require('./shared');

const getBranchWiseAppointmentsReport = async (filters) => {
    const { whereClause, params } = buildAppointmentReportScope(filters);

    return query(
        `SELECT
            b.id AS branch_id,
            b.branch_name,
            COUNT(a.appointment_id) AS total_appointments,
            SUM(CASE WHEN a.status = 'Pending' THEN 1 ELSE 0 END) AS pending_appointments,
            SUM(CASE WHEN a.status = 'Confirmed' THEN 1 ELSE 0 END) AS confirmed_appointments,
            SUM(CASE WHEN a.status = 'Completed' THEN 1 ELSE 0 END) AS completed_appointments,
            SUM(CASE WHEN a.status = 'Cancelled' THEN 1 ELSE 0 END) AS cancelled_appointments
         FROM tbl_appointments a
         JOIN master_clinic_branches b ON b.id = a.fk_branch_id
         ${whereClause}
         GROUP BY b.id, b.branch_name
         ORDER BY total_appointments DESC, b.branch_name ASC`,
        params
    );
};

module.exports = getBranchWiseAppointmentsReport;
