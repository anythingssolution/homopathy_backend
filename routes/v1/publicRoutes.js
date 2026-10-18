const express = require('express');
const { getPublicStatus } = require('../../controllers/v1/doctorSessionController');
const { getPublicDoctorBookingAvailability } = require('../../controllers/v1/doctorLeaveController');
const { getPublicHomepageCms, getPublicGalleryCms } = require('../../controllers/v1/publicCmsController');
const { getPublicScheduleRules } = require('../../controllers/v1/doctorScheduleRuleController');
const { getPublicCallTune } = require('../../controllers/v1/callTuneController');

const router = express.Router();

const { getDateAvailability } = require('../../controllers/v1/bookingWeekdayController');
router.get('/booking-date-availability', getDateAvailability);

router.get('/doctor-status', getPublicStatus);
router.get('/doctor-booking-availability', getPublicDoctorBookingAvailability);
router.get('/schedule-rules', getPublicScheduleRules);
router.get('/call-tune', getPublicCallTune);
router.get('/cms/homepage', getPublicHomepageCms);
router.get('/cms/gallery', getPublicGalleryCms);

module.exports = router;
