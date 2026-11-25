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

const staffSources = require('../../services/patientDiscoverySourceService');
exports.getStaffSource = asyncHandler(async (req, res) => {
    res.json({ success: true, data: await staffSources.getStaffSource(req.params.appointment_id, req.originalUrl.includes('/booking-discovery/') ? req.user.id : null) });
});
exports.saveStaffSource = asyncHandler(async (req, res) => {
    res.json({ success: true, data: await staffSources.saveStaffSource(req.params.appointment_id, req.body, req.originalUrl.includes('/booking-discovery/') ? req.user.id : null) });
});
exports.pendingStaffSource = asyncHandler(async (req, res) => {
    res.json({ success: true, data: await staffSources.getPendingReceptionSource(req.user.id) });
});
exports.pendingCheckInSource = asyncHandler(async (req, res) => {
    res.json({ success: true, data: await staffSources.getPendingReceptionCheckInSource(req.user.id, req.selectedBranchId) });
});
