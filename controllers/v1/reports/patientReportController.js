const asyncHandler = require('../../../utils/asyncHandler');
const { getPatientReports } = require('../../../services/reports/patient');
const { buildReportResponseMeta, parseReportFilters } = require('./shared');

const getPatientReportsController = asyncHandler(async (req, res) => {
    const filters = parseReportFilters(req);
    const reports = await getPatientReports(filters);

    return res.status(200).json({
        success: true,
        message: 'Patient reports fetched successfully',
        data: reports,
        meta: buildReportResponseMeta({ filters, reports }),
    });
});

module.exports = {
    getPatientReportsController,
};
