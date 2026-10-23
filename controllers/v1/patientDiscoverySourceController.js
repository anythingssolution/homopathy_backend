const asyncHandler = require('../../utils/asyncHandler');
const { getDiscoverySource, saveDiscoverySource, getPatientSourceReport } = require('../../services/patientDiscoverySourceService');
const { parseReportFilters } = require('./reports/shared');
exports.getSource = asyncHandler(async (req, res) => {
    res.json({ success: true, data: await getDiscoverySource(req.params.appointment_id, req.user.id) });
});
exports.saveSource = asyncHandler(async (req, res) => {
    res.json({ success: true, message: 'Thank you for sharing', data: await saveDiscoverySource(req.params.appointment_id, req.user.id, req.body) });
});
exports.getSourceReport = asyncHandler(async (req, res) => {
    res.json({ success: true, data: await getPatientSourceReport(parseReportFilters(req)) });
});
