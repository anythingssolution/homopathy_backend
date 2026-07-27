const asyncHandler = require('../../../utils/asyncHandler');
const { getMedicalReports } = require('../../../services/reports/medical');
const { buildReportResponseMeta, parseReportFilters } = require('./shared');

const getMedicalReportsController = asyncHandler(async (req, res) => {
    const filters = parseReportFilters(req);
    const reports = await getMedicalReports(filters);

    return res.status(200).json({
        success: true,
        message: 'Medical reports fetched successfully',
        data: reports,
        meta: buildReportResponseMeta({ filters, reports }),
    });
});

module.exports = {
    getMedicalReportsController,
};
