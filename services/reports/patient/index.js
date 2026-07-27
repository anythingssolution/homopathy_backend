const getPatientSummaryReport = require('./summary');
const getPatientMasterListReport = require('./patientMasterList');
const getPatientAppointmentHistoryReport = require('./patientAppointmentHistory');
const getNewVsRepeatPatientReport = require('./newVsRepeatPatient');
const getFamilyMemberPatientReport = require('./familyMemberPatient');
const getPatientUpdateAuditHistoryReport = require('./patientUpdateAuditHistory');
const getGenderAgeGroupPatientReport = require('./genderAgeGroupPatient');

const getPatientReports = async (filters) => {
    const [
        summary,
        patientMasterList,
        patientAppointmentHistory,
        newVsRepeatPatient,
        familyMemberPatient,
        patientUpdateAuditHistory,
        genderAgeGroupPatient,
    ] = await Promise.all([
        getPatientSummaryReport(filters),
        getPatientMasterListReport(filters),
        getPatientAppointmentHistoryReport(filters),
        getNewVsRepeatPatientReport(filters),
        getFamilyMemberPatientReport(filters),
        getPatientUpdateAuditHistoryReport(filters),
        getGenderAgeGroupPatientReport(filters),
    ]);

    return {
        summary,
        patient_master_list: patientMasterList,
        patient_appointment_history: patientAppointmentHistory,
        new_vs_repeat_patient: newVsRepeatPatient,
        family_member_patient: familyMemberPatient,
        patient_update_audit_history: patientUpdateAuditHistory,
        gender_age_group_patient: genderAgeGroupPatient,
    };
};

module.exports = {
    getPatientReports,
};
