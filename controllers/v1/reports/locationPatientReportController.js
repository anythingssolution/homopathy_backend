const asyncHandler = require('../../../utils/asyncHandler');
const { parseReportFilters, buildReportResponseMeta } = require('./shared');
const { getLocationPatients } = require('../../../services/reports/patient/locationPatients');
const getLocationPatientReportController = asyncHandler(async (req,res) => {
    const filters = parseReportFilters(req);
    const reports = await getLocationPatients(filters);
    res.json({ success:true, message:'Location patient report fetched', data:reports,
        meta:buildReportResponseMeta({ filters,reports }) });
});
module.exports = { getLocationPatientReportController };
