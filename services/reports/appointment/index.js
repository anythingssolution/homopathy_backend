const getDateWiseAppointmentsReport = require('./dateWiseAppointments');
const getBranchWiseAppointmentsReport = require('./branchWiseAppointments');
const getSlotWiseAppointmentsReport = require('./slotWiseAppointments');
const getTreatmentWiseAppointmentsReport = require('./treatmentWiseAppointments');
const getStatusAppointmentsReport = require('./statusAppointments');
const getReceptionStatusAppointmentsReport = require('./receptionStatusAppointments');
const getBookingSourceAppointmentsReport = require('./bookingSourceAppointments');
const getBookingSubjectAppointmentsReport = require('./bookingSubjectAppointments');
const getFirstConsultationsReport = require('./firstConsultations');

const getAppointmentReports = async (filters) => {
    const [
        dateWiseAppointments,
        branchWiseAppointments,
        slotWiseAppointments,
        treatmentWiseAppointments,
        statusAppointments,
        receptionStatusAppointments,
        bookingSourceAppointments,
        bookingSubjectAppointments,
        firstConsultations,
    ] = await Promise.all([
        getDateWiseAppointmentsReport(filters),
        getBranchWiseAppointmentsReport(filters),
        getSlotWiseAppointmentsReport(filters),
        getTreatmentWiseAppointmentsReport(filters),
        getStatusAppointmentsReport(filters),
        getReceptionStatusAppointmentsReport(filters),
        getBookingSourceAppointmentsReport(filters),
        getBookingSubjectAppointmentsReport(filters),
        getFirstConsultationsReport(filters),
    ]);

    return {
        date_wise_appointments: dateWiseAppointments,
        branch_wise_appointments: branchWiseAppointments,
        slot_wise_appointments: slotWiseAppointments,
        treatment_wise_appointments: treatmentWiseAppointments,
        status_appointments: statusAppointments,
        reception_status_appointments: receptionStatusAppointments,
        booking_source_appointments: bookingSourceAppointments,
        booking_subject_appointments: bookingSubjectAppointments,
        first_consultations: firstConsultations,
    };
};

module.exports = {
    getAppointmentReports,
};
