const asyncHandler = require('../../../utils/asyncHandler');
const getTestRegisterReport = require('../../../services/reports/medical/testRegister');
const { buildReportResponseMeta, parseReportFilters } = require('./shared');

const getTestRegisterReportController = asyncHandler(async (req, res) => {
    const filters = parseReportFilters(req);
    const rows = await getTestRegisterReport(filters);

    return res.status(200).json({
        success: true,
        message: 'Test register fetched successfully',
        data: { rows },
        meta: buildReportResponseMeta({ filters, report: rows }),
    });
});

module.exports = {
    getTestRegisterReportController,
};
