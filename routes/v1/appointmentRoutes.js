const express = require('express');
const {
    getAppointmentFormData,
    getBookingTokenPlate,
    listEligibleFollowUpsForBooking,
    createAppointment,
    listMyAppointments,
    cancelAppointment,
} = require('../../controllers/v1/appointmentController');
const { authenticate, authorizeRoles } = require('../../middleware/authMiddleware');

const router = express.Router();

router.get('/form-data', authenticate, authorizeRoles('patient'), getAppointmentFormData);
router.get('/token-plate', authenticate, authorizeRoles('patient', 'receptionist'), getBookingTokenPlate);
router.get('/eligible-followups', authenticate, authorizeRoles('patient', 'receptionist'), listEligibleFollowUpsForBooking);
router.post('/', authenticate, authorizeRoles('patient'), createAppointment);
router.get('/my', authenticate, authorizeRoles('patient'), listMyAppointments);
router.patch('/:appointment_id/cancel', authenticate, authorizeRoles('patient', 'doctor', 'receptionist', 'medical'), cancelAppointment);

module.exports = router;
