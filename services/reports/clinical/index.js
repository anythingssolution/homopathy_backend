const getClinicalSummaryReport = require('./summary');
const getConsultationHistoryReport = require('./consultationHistory');
const getTreatmentDurationReport = require('./treatmentDuration');
const getFollowupDueReport = require('./followupDue');
const getRepeatTreatmentChainReport = require('./repeatTreatmentChain');
const getDiagnosisDiseaseReport = require('./diagnosisDisease');
const getConsultationWorkflowReport = require('./consultationWorkflow');

const getClinicalReports = async (filters) => {
    const [
        summary,
        consultationHistory,
        treatmentDuration,
        followupDue,
        repeatTreatmentChain,
        diagnosisDisease,
        consultationWorkflow,
    ] = await Promise.all([
        getClinicalSummaryReport(filters),
        getConsultationHistoryReport(filters),
        getTreatmentDurationReport(filters),
        getFollowupDueReport(filters),
        getRepeatTreatmentChainReport(filters),
        getDiagnosisDiseaseReport(filters),
        getConsultationWorkflowReport(filters),
    ]);

    return {
        summary,
        consultation_history: consultationHistory,
        treatment_duration: treatmentDuration,
        followup_due: followupDue,
        repeat_treatment_chain: repeatTreatmentChain,
        diagnosis_disease: diagnosisDisease,
        consultation_workflow: consultationWorkflow,
    };
};

module.exports = {
    getClinicalReports,
};
