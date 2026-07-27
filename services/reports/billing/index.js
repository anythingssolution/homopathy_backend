const getTotalRevenueReport = require('./totalRevenue');
const getConsultationBillReport = require('./consultationBill');
const getMedicationBillReport = require('./medicationBill');
const getPaymentStatusReport = require('./paymentStatus');
const getPendingAmountReport = require('./pendingAmount');
const getPaymentModeCollectionReport = require('./paymentModeCollection');
const getBranchWiseRevenueReport = require('./branchWiseRevenue');
const getPatientBillingHistoryReport = require('./patientBillingHistory');

const getBillingReports = async (filters) => {
    const [
        totalRevenue,
        consultationBill,
        medicationBill,
        paymentStatus,
        pendingAmount,
        paymentModeCollection,
        branchWiseRevenue,
        patientBillingHistory,
    ] = await Promise.all([
        getTotalRevenueReport(filters),
        getConsultationBillReport(filters),
        getMedicationBillReport(filters),
        getPaymentStatusReport(filters),
        getPendingAmountReport(filters),
        getPaymentModeCollectionReport(filters),
        getBranchWiseRevenueReport(filters),
        getPatientBillingHistoryReport(filters),
    ]);

    return {
        total_revenue: totalRevenue,
        consultation_bill: consultationBill,
        medication_bill: medicationBill,
        payment_status: paymentStatus,
        pending_amount: pendingAmount,
        payment_mode_collection: paymentModeCollection,
        branch_wise_revenue: branchWiseRevenue,
        patient_billing_history: patientBillingHistory,
    };
};

module.exports = {
    getBillingReports,
};
