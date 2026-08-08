const asyncHandler = require('../../../utils/asyncHandler');
const { getAppointmentReports } = require('../../../services/reports/appointment');
const getBookedVsConsultedReport = require('../../../services/reports/appointment/bookedVsConsulted');
const { buildReportResponseMeta, parseReportFilters } = require('./shared');

const getAppointmentReportsController = asyncHandler(async (req, res) => {
    const filters = parseReportFilters(req);
    const reports = await getAppointmentReports(filters);

    return res.status(200).json({
        success: true,
        message: 'Appointment reports fetched successfully',
        data: reports,
        meta: buildReportResponseMeta({ filters, reports }),
    });
});

const getBookedVsConsultedController = asyncHandler(async (req, res) => {
    const branchId = req.query.branch_id ? Number(req.query.branch_id) : null;
    const filters = {
        year: req.query.year || new Date().getFullYear(),
        month: req.query.month || null,
        date: req.query.date || null,
        branchId: branchId && !isNaN(branchId) ? branchId : null,
    };
    const reportData = await getBookedVsConsultedReport(filters);

    return res.status(200).json({
        success: true,
        message: 'Booked vs Consulted drilldown report fetched successfully',
        data: reportData,
    });
});

module.exports = {
    getAppointmentReportsController,
    getBookedVsConsultedController,
};
