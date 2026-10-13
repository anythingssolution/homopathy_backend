const asyncHandler = require('../../../utils/asyncHandler');
const getTestRegisterReport = require('../../../services/reports/medical/testRegister');
const { saveTestReportSendStatus } = require('../../../services/reports/medical/testReportSendStatus');
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

const updateTestReportSendStatusController = asyncHandler(async (req, res) => {
    const row = await saveTestReportSendStatus({
        sourceType: req.body?.source_type,
        sourceId: req.body?.source_id,
        status: req.body?.status,
        reason: req.body?.reason,
        actorUserId: req.user?.id || null,
        selectedBranchId: req.selectedBranchId || req.body?.branch_id || null,
    });

    return res.status(200).json({
        success: true,
        message: 'Test report send status saved successfully',
        data: { row },
    });
});

module.exports = {
    getTestRegisterReportController,
    updateTestReportSendStatusController,
};
