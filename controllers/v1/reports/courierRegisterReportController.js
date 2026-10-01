const asyncHandler = require('../../../utils/asyncHandler');
const getCourierRegisterReport = require('../../../services/reports/medical/courierRegister');
const { buildReportResponseMeta, parseReportFilters } = require('./shared');

const getCourierRegisterReportController = asyncHandler(async (req, res) => {
    const filters = parseReportFilters(req);
    const rows = await getCourierRegisterReport(filters);

    return res.status(200).json({
        success: true,
        message: 'Courier register fetched successfully',
        data: { rows },
        meta: buildReportResponseMeta({ filters, report: rows }),
    });
});

module.exports = {
    getCourierRegisterReportController,
};
