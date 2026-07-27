const getMedicalSummaryReport = require('./summary');
const getMedicalDateWiseSummaryReport = require('./dateWiseSummary');
const getReadyPrescriptionsReport = require('./readyPrescriptions');
const getProcessedPrescriptionsReport = require('./processedPrescriptions');
const getMedicinePricingReport = require('./medicinePricing');
const getLabTestMedicineItemReport = require('./labTestMedicineItem');
const getMedicalProcessedByUserReport = require('./medicalProcessedByUser');

const getMedicalReports = async (filters) => {
    const [
        summary,
        dateWiseSummary,
        readyPrescriptions,
        processedPrescriptions,
        medicinePricing,
        labTestMedicineItem,
        medicalProcessedByUser,
    ] = await Promise.all([
        getMedicalSummaryReport(filters),
        getMedicalDateWiseSummaryReport(filters),
        getReadyPrescriptionsReport(filters),
        getProcessedPrescriptionsReport(filters),
        getMedicinePricingReport(filters),
        getLabTestMedicineItemReport(filters),
        getMedicalProcessedByUserReport(filters),
    ]);

    return {
        summary,
        date_wise_summary: dateWiseSummary,
        ready_prescriptions: readyPrescriptions,
        processed_prescriptions: processedPrescriptions,
        medicine_pricing: medicinePricing,
        lab_test_medicine_item: labTestMedicineItem,
        medical_processed_by_user: medicalProcessedByUser,
    };
};

module.exports = {
    getMedicalReports,
};
