const asyncHandler = require('../../../utils/asyncHandler');
const { getClinicalReports } = require('../../../services/reports/clinical');
const { buildReportResponseMeta, parseReportFilters } = require('./shared');

const getClinicalReportsController = asyncHandler(async (req, res) => {
    const filters = parseReportFilters(req);
    const reports = await getClinicalReports(filters);

    return res.status(200).json({
        success: true,
        message: 'Clinical reports fetched successfully',
        data: reports,
        meta: buildReportResponseMeta({ filters, reports }),
    });
});

module.exports = {
    getClinicalReportsController,
};
