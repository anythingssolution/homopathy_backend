const express = require('express');
const { getPublicStatus } = require('../../controllers/v1/doctorSessionController');
const { getPublicDoctorBookingAvailability } = require('../../controllers/v1/doctorLeaveController');
const { getPublicHomepageCms, getPublicGalleryCms } = require('../../controllers/v1/publicCmsController');

const router = express.Router();

router.get('/doctor-status', getPublicStatus);
router.get('/doctor-booking-availability', getPublicDoctorBookingAvailability);
router.get('/cms/homepage', getPublicHomepageCms);
router.get('/cms/gallery', getPublicGalleryCms);

module.exports = router;
