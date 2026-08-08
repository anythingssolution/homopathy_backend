const { query } = require('./shared');

const CONSULTED_SQL = "(a.status = 'Completed' OR c.id IS NOT NULL)";
const REJECTED_SQL = `(
    NOT ${CONSULTED_SQL}
    AND a.reception_status = 'REJECTED_BY_RECEPTION'
)`;
const CANCELLED_SQL = `(
    NOT ${CONSULTED_SQL}
    AND COALESCE(a.reception_status, '') <> 'REJECTED_BY_RECEPTION'
    AND (a.status = 'Cancelled' OR a.queue_status = 'CANCELLED')
)`;

const normalizeReportBreakdown = (row = {}) => {
    const bookedCount = Number(row.booked_count || 0);
    const consultedCount = Number(row.consulted_count || 0);
    const rejectedCount = Number(row.rejected_count || 0);
    const cancelledCount = Number(row.cancelled_count || 0);

    return {
        booked_count: bookedCount,
        consulted_count: consultedCount,
        rejected_count: rejectedCount,
        cancelled_count: cancelledCount,
        unconsulted_count: Math.max(0, bookedCount - consultedCount - rejectedCount - cancelledCount),
    };
};

const formatDateKey = (val) => {
    if (!val) return '';
    if (typeof val === 'string') return val.slice(0, 10);
    if (val instanceof Date) {
        const y = val.getFullYear();
        const m = String(val.getMonth() + 1).padStart(2, '0');
        const d = String(val.getDate()).padStart(2, '0');
        return `${y}-${m}-${d}`;
    }
    return String(val).slice(0, 10);
};

const getBookedVsConsultedReport = async (filters) => {
    const selectedYear = Number(filters.year) || new Date().getFullYear();
    const selectedMonth = filters.month ? Number(filters.month) : null;
    const selectedDate = filters.date ? String(filters.date).trim() : null;
    const branchId = filters.branchId ? Number(filters.branchId) : null;

    // 1. If a specific single date is selected (Level 3 - Patient List)
    if (selectedDate && /^\d{4}-\d{2}-\d{2}$/.test(selectedDate)) {
        let whereSql = `WHERE a.appointment_date = ?`;
        let params = [selectedDate];

        if (branchId) {
            whereSql += ` AND a.fk_branch_id = ?`;
            params.push(branchId);
        }

        const patients = await query(
            `SELECT
                a.appointment_id,
                a.current_token_number AS token_number,
                a.appointment_date,
                a.status,
                a.queue_status,
                a.is_active,
                a.reception_status,
                a.reception_rejected_at,
                a.reception_rejection_reason,
                a.booked_for_type,
                a.symptoms,
                a.created_at,
                t.treatment_name,
                b.branch_name,
                s.slot_name,
                c.id AS consultation_id,
                CASE WHEN ${CONSULTED_SQL} THEN 1 ELSE 0 END AS is_consulted,
                CASE WHEN ${REJECTED_SQL} THEN 1 ELSE 0 END AS is_rejected,
                CASE WHEN ${CANCELLED_SQL} THEN 1 ELSE 0 END AS is_cancelled,
                CASE
                    WHEN a.booked_for_type = 'FAMILY_MEMBER' THEN COALESCE(fm.full_name, 'Family Member')
                    ELSE COALESCE(p.full_name, 'Patient')
                END AS patient_name,
                COALESCE(p.uuid, 'N/A') AS patient_uuid,
                COALESCE(p.mobile_no, 'N/A') AS patient_mobile
             FROM tbl_appointments a
             JOIN master_treatments t ON t.id = a.fk_treatment_id
             JOIN master_clinic_branches b ON b.id = a.fk_branch_id
             JOIN master_slots s ON s.id = a.fk_slot_id
             LEFT JOIN master_users p ON p.id = a.fk_patient_id
             LEFT JOIN tbl_patient_family_members fm ON fm.id = a.fk_patient_family_member_id
             LEFT JOIN tbl_consultations c ON c.appointment_id = a.appointment_id
             ${whereSql}
             ORDER BY a.current_token_number ASC, a.appointment_id ASC`,
            params
        );

        const totalConsulted = patients.filter((patient) => Boolean(Number(patient.is_consulted))).length;
        const totalRejected = patients.filter((patient) => Boolean(Number(patient.is_rejected))).length;
        const totalCancelled = patients.filter((patient) => Boolean(Number(patient.is_cancelled))).length;

        return {
            level: 'DAY_PATIENTS',
            date: selectedDate,
            patients,
            total_booked: patients.length,
            total_consulted: totalConsulted,
            total_rejected: totalRejected,
            total_cancelled: totalCancelled,
            total_unconsulted: Math.max(0, patients.length - totalConsulted - totalRejected - totalCancelled),
        };
    }

    // 2. If a specific month is selected (Level 2 - Day-wise for selected month)
    if (selectedMonth && selectedMonth >= 1 && selectedMonth <= 12) {
        const startDate = `${selectedYear}-${String(selectedMonth).padStart(2, '0')}-01`;
        const endDateObj = new Date(selectedYear, selectedMonth, 0);
        const endDate = `${selectedYear}-${String(selectedMonth).padStart(2, '0')}-${String(endDateObj.getDate()).padStart(2, '0')}`;

        let whereSql = `WHERE a.appointment_date >= ? AND a.appointment_date <= ?`;
        let params = [startDate, endDate];

        if (branchId) {
            whereSql += ` AND a.fk_branch_id = ?`;
            params.push(branchId);
        }

        const dailyRows = await query(
            `SELECT
                DATE_FORMAT(a.appointment_date, '%Y-%m-%d') AS appointment_date,
                COUNT(a.appointment_id) AS booked_count,
                SUM(CASE WHEN ${CONSULTED_SQL} THEN 1 ELSE 0 END) AS consulted_count,
                SUM(CASE WHEN ${REJECTED_SQL} THEN 1 ELSE 0 END) AS rejected_count,
                SUM(CASE WHEN ${CANCELLED_SQL} THEN 1 ELSE 0 END) AS cancelled_count,
                SUM(CASE WHEN a.status = 'Pending' AND c.id IS NULL THEN 1 ELSE 0 END) AS pending_count,
                SUM(CASE WHEN a.status = 'Confirmed' AND c.id IS NULL THEN 1 ELSE 0 END) AS confirmed_count
             FROM tbl_appointments a
             LEFT JOIN tbl_consultations c ON c.appointment_id = a.appointment_id
             ${whereSql}
             GROUP BY DATE_FORMAT(a.appointment_date, '%Y-%m-%d')
             ORDER BY appointment_date ASC`,
            params
        );

        const dayMap = new Map(dailyRows.map(r => [
            formatDateKey(r.appointment_date),
            r
        ]));

        const totalDays = endDateObj.getDate();
        const days = [];
        let totalBookedMonth = 0;
        let totalConsultedMonth = 0;
        let totalUnconsultedMonth = 0;
        let totalRejectedMonth = 0;
        let totalCancelledMonth = 0;

        for (let d = 1; d <= totalDays; d++) {
            const dateStr = `${selectedYear}-${String(selectedMonth).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
            const row = dayMap.get(dateStr);
            const breakdown = normalizeReportBreakdown(row);
            const pending = row ? Number(row.pending_count) : 0;
            const confirmed = row ? Number(row.confirmed_count) : 0;

            totalBookedMonth += breakdown.booked_count;
            totalConsultedMonth += breakdown.consulted_count;
            totalUnconsultedMonth += breakdown.unconsulted_count;
            totalRejectedMonth += breakdown.rejected_count;
            totalCancelledMonth += breakdown.cancelled_count;

            const dayObj = new Date(selectedYear, selectedMonth - 1, d);
            const dayName = dayObj.toLocaleDateString('en-US', { weekday: 'short' });

            days.push({
                date: dateStr,
                day_number: d,
                day_name: dayName,
                ...breakdown,
                pending_count: pending,
                confirmed_count: confirmed,
                consultation_rate: breakdown.booked_count > 0
                    ? Number(((breakdown.consulted_count / breakdown.booked_count) * 100).toFixed(1))
                    : 0,
            });
        }

        const monthName = new Date(selectedYear, selectedMonth - 1, 1).toLocaleDateString('en-US', { month: 'long' });

        return {
            level: 'MONTH_DAYS',
            year: selectedYear,
            month: selectedMonth,
            month_name: monthName,
            total_days: totalDays,
            days,
            total_booked_month: totalBookedMonth,
            total_consulted_month: totalConsultedMonth,
            total_unconsulted_month: totalUnconsultedMonth,
            total_rejected_month: totalRejectedMonth,
            total_cancelled_month: totalCancelledMonth,
            overall_consultation_rate: totalBookedMonth > 0 ? Number(((totalConsultedMonth / totalBookedMonth) * 100).toFixed(1)) : 0
        };
    }

    // 3. Default: Level 1 - Month-wise for selected year (12 Months)
    const startDate = `${selectedYear}-01-01`;
    const endDate = `${selectedYear}-12-31`;

    let whereSql = `WHERE a.appointment_date >= ? AND a.appointment_date <= ?`;
    let params = [startDate, endDate];

    if (branchId) {
        whereSql += ` AND a.fk_branch_id = ?`;
        params.push(branchId);
    }

    const monthlyRows = await query(
        `SELECT
            MONTH(a.appointment_date) AS month_num,
            COUNT(a.appointment_id) AS booked_count,
            SUM(CASE WHEN ${CONSULTED_SQL} THEN 1 ELSE 0 END) AS consulted_count,
            SUM(CASE WHEN ${REJECTED_SQL} THEN 1 ELSE 0 END) AS rejected_count,
            SUM(CASE WHEN ${CANCELLED_SQL} THEN 1 ELSE 0 END) AS cancelled_count,
            SUM(CASE WHEN a.status = 'Pending' AND c.id IS NULL THEN 1 ELSE 0 END) AS pending_count,
            SUM(CASE WHEN a.status = 'Confirmed' AND c.id IS NULL THEN 1 ELSE 0 END) AS confirmed_count
         FROM tbl_appointments a
         LEFT JOIN tbl_consultations c ON c.appointment_id = a.appointment_id
         ${whereSql}
         GROUP BY MONTH(a.appointment_date)
         ORDER BY month_num ASC`,
        params
    );

    const monthMap = new Map(monthlyRows.map(r => [Number(r.month_num), r]));
    const months = [];
    let totalBookedYear = 0;
    let totalConsultedYear = 0;
    let totalUnconsultedYear = 0;
    let totalRejectedYear = 0;
    let totalCancelledYear = 0;

    for (let m = 1; m <= 12; m++) {
        const row = monthMap.get(m);
        const breakdown = normalizeReportBreakdown(row);
        const pending = row ? Number(row.pending_count) : 0;
        const confirmed = row ? Number(row.confirmed_count) : 0;

        totalBookedYear += breakdown.booked_count;
        totalConsultedYear += breakdown.consulted_count;
        totalUnconsultedYear += breakdown.unconsulted_count;
        totalRejectedYear += breakdown.rejected_count;
        totalCancelledYear += breakdown.cancelled_count;

        const mObj = new Date(selectedYear, m - 1, 1);
        const monthName = mObj.toLocaleDateString('en-US', { month: 'long' });

        months.push({
            month: m,
            month_name: monthName,
            ...breakdown,
            pending_count: pending,
            confirmed_count: confirmed,
            consultation_rate: breakdown.booked_count > 0
                ? Number(((breakdown.consulted_count / breakdown.booked_count) * 100).toFixed(1))
                : 0,
        });
    }

    return {
        level: 'YEAR_MONTHS',
        year: selectedYear,
        months,
        total_booked_year: totalBookedYear,
        total_consulted_year: totalConsultedYear,
        total_unconsulted_year: totalUnconsultedYear,
        total_rejected_year: totalRejectedYear,
        total_cancelled_year: totalCancelledYear,
        overall_consultation_rate: totalBookedYear > 0 ? Number(((totalConsultedYear / totalBookedYear) * 100).toFixed(1)) : 0
    };
};

module.exports = getBookedVsConsultedReport;
module.exports.normalizeReportBreakdown = normalizeReportBreakdown;
