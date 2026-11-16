const { asyncHandler, AppError, toPositiveInt, getDoctorAppointmentById, getConsultationAggregateByAppointmentId, getMedicalPricingAggregateByConsultationId } = require('./shared');
const { getConsultationPreferences, saveConsultationPreferences, findLastCompletedVisit } = require('../../../services/consultationPrefillService');

const getDoctorConsultationPreferences = asyncHandler(async (req, res) => res.json({
    success: true, data: await getConsultationPreferences(req.user.id),
}));

const updateDoctorConsultationPreferences = asyncHandler(async (req, res) => res.json({
    success: true, data: await saveConsultationPreferences(req.user.id, req.body?.autofill_last_visit),
}));

const getLastVisitPrefill = asyncHandler(async (req, res) => {
    const appointmentId = toPositiveInt(req.params.appointment_id);
    if (!appointmentId) throw new AppError('Valid appointment_id is required', 400);
    const preferences = await getConsultationPreferences(req.user.id);
    if (!preferences.autofill_last_visit) return res.json({ success: true, data: { enabled: false, source: null } });
    // Keep access to the current booking scoped; only its clinical history spans branches.
    const appointment = await getDoctorAppointmentById(appointmentId, req.selectedBranchId || null);
    if (!appointment) throw new AppError('Appointment not found', 404);
    if (appointment.status === 'Completed' || appointment.status === 'Cancelled' || Number(appointment.is_active) !== 1) {
        return res.json({ success: true, data: { enabled: true, source: null } });
    }
    const source = await findLastCompletedVisit(appointment);
    const consultation = source ? await getConsultationAggregateByAppointmentId(source.appointment_id) : null;
    const pricing = consultation ? await getMedicalPricingAggregateByConsultationId(consultation.consultation_id) : null;
    return res.json({ success: true, data: { enabled: true, source: consultation ? source : null, consultation, pricing } });
});

module.exports = { getDoctorConsultationPreferences, updateDoctorConsultationPreferences, getLastVisitPrefill };
