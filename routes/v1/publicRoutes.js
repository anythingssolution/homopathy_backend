const express = require('express');
const { getPublicStatus } = require('../../controllers/v1/doctorSessionController');
const { getPublicDoctorBookingAvailability } = require('../../controllers/v1/doctorLeaveController');
const {
    getSystemLogsOverview,
    getSystemLogFile,
} = require('../../controllers/v1/systemLogsController');
const { getPublicHomepageCms, getPublicGalleryCms } = require('../../controllers/v1/publicCmsController');

const router = express.Router();

router.get('/doctor-status', getPublicStatus);
router.get('/doctor-booking-availability', getPublicDoctorBookingAvailability);
router.get('/cms/homepage', getPublicHomepageCms);
router.get('/cms/gallery', getPublicGalleryCms);
router.get('/system-logs/overview', getSystemLogsOverview);
router.get('/system-logs/file/:fileName', getSystemLogFile);

module.exports = router;
