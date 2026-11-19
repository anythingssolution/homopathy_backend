const { AppError, asyncHandler, getDoctorAppointmentById, getConsultationAggregateByAppointmentId,
    getMedicalPricingAggregateByConsultationId } = require('../doctor/shared');

// authorizeReportEntity has already checked the appointment's actual branch.
// Return the existing prescription DTO without edit permissions or an unscoped
// follow-up chain from branches outside this report's authorized selection.
const getReportPrescription = asyncHandler(async (req, res) => {
    const id = Number(req.params.appointment_id);
    const appointment = await getDoctorAppointmentById(id, req.selectedBranchId);
    if (!appointment) throw new AppError('Appointment not found', 404);
    const consultation = await getConsultationAggregateByAppointmentId(id);
    if (!consultation) throw new AppError('Consultation not found for this appointment', 404);
    const pricing = await getMedicalPricingAggregateByConsultationId(consultation.consultation_id);
    res.json({ success: true, data: { appointment, consultation, pricing } });
});

module.exports = { getReportPrescription };
