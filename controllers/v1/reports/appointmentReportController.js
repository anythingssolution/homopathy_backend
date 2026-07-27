const asyncHandler = require('../../../utils/asyncHandler');
const { getAppointmentReports } = require('../../../services/reports/appointment');
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

module.exports = {
    getAppointmentReportsController,
};
