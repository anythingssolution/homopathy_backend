const asyncHandler = require('../../../utils/asyncHandler');
const { getBillingReports } = require('../../../services/reports/billing');
const { buildReportResponseMeta, parseReportFilters } = require('./shared');

const getBillingReportsController = asyncHandler(async (req, res) => {
    const filters = parseReportFilters(req);
    const reports = await getBillingReports(filters);

    return res.status(200).json({
        success: true,
        message: 'Billing reports fetched successfully',
        data: reports,
        meta: buildReportResponseMeta({ filters, reports }),
    });
});

module.exports = {
    getBillingReportsController,
};
