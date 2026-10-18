const asyncHandler = require('../../utils/asyncHandler');
const { getDoctorBookingWeekdays, saveDoctorBookingWeekdays, getDateBookingAvailability } = require('../../services/bookingWeekdayService');
exports.getBookingWeekdays = asyncHandler(async (req, res) => res.set('Cache-Control', 'no-store').json({ success: true,
    data: await getDoctorBookingWeekdays(req.user.id) }));
exports.saveBookingWeekdays = asyncHandler(async (req, res) => res.set('Cache-Control', 'no-store').json({ success: true,
    message: 'Booking schedule saved. Existing appointments remain unchanged.',
    data: await saveDoctorBookingWeekdays({ doctorId: req.user.id, revision: req.body?.revision, changes: req.body?.changes }) }));
exports.getDateAvailability = asyncHandler(async (req, res) => res.set('Cache-Control', 'no-store').json({ success: true,
    data: await getDateBookingAvailability(String(req.query.date || '')) }));
