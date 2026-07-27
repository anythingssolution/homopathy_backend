const { buildAppointmentReportScope, query } = require('./shared');

const getSlotWiseAppointmentsReport = async (filters) => {
    const { whereClause, params } = buildAppointmentReportScope(filters);

    return query(
        `SELECT
            s.id AS slot_id,
            s.slot_name,
            b.id AS branch_id,
            b.branch_name,
            s.start_time,
            s.end_time,
            COUNT(a.appointment_id) AS total_appointments,
            SUM(CASE WHEN a.status = 'Pending' THEN 1 ELSE 0 END) AS pending_appointments,
            SUM(CASE WHEN a.status = 'Confirmed' THEN 1 ELSE 0 END) AS confirmed_appointments,
            SUM(CASE WHEN a.status = 'Completed' THEN 1 ELSE 0 END) AS completed_appointments,
            SUM(CASE WHEN a.status = 'Cancelled' THEN 1 ELSE 0 END) AS cancelled_appointments
         FROM tbl_appointments a
         JOIN master_slots s ON s.id = a.fk_slot_id
         JOIN master_clinic_branches b ON b.id = a.fk_branch_id
         ${whereClause}
         GROUP BY s.id, s.slot_name, b.id, b.branch_name, s.start_time, s.end_time
         ORDER BY b.branch_name ASC, start_time ASC, s.slot_name ASC`,
        params
    );
};

module.exports = getSlotWiseAppointmentsReport;
