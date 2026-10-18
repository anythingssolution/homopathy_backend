const asyncHandler = require('../../../utils/asyncHandler');
const { parseReportFilters } = require('./shared');
const { getNotReturnedReport } = require('../../../services/reports/patient/notReturned');

const getNotReturnedReportController = asyncHandler(async (req, res) => {
    const data = await getNotReturnedReport(parseReportFilters(req));
    res.json({ success: true, message: 'Patients not returned report fetched', data });
});
module.exports = { getNotReturnedReportController };
