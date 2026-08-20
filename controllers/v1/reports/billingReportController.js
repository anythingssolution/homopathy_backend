const asyncHandler = require('../../../utils/asyncHandler');
const { getBillingReports, getRevenueByConsultantReport, getRevenueByMedicineReport } = require('../../../services/reports/billing');
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

const getRevenueByConsultantController = asyncHandler(async (req, res) => {
    const filters = parseReportFilters(req);
    const report = await getRevenueByConsultantReport(filters);

    return res.status(200).json({
        success: true,
        message: 'Revenue by consultant report fetched successfully',
        data: report,
        meta: buildReportResponseMeta({ filters, reports: report }),
    });
});

const getRevenueByMedicineController = asyncHandler(async (req, res) => {
    const filters = parseReportFilters(req);
    const report = await getRevenueByMedicineReport(filters);

    return res.status(200).json({
        success: true,
        message: 'Revenue by medicine report fetched successfully',
        data: report,
        meta: buildReportResponseMeta({ filters, reports: report }),
    });
});

module.exports = {
    getBillingReportsController,
    getRevenueByConsultantController,
    getRevenueByMedicineController,
};
