const getTotalRevenueReport = require('./totalRevenue');
const getConsultationBillReport = require('./consultationBill');
const getMedicationBillReport = require('./medicationBill');
const getPaymentStatusReport = require('./paymentStatus');
const getPendingAmountReport = require('./pendingAmount');
const getPaymentModeCollectionReport = require('./paymentModeCollection');
const getBranchWiseRevenueReport = require('./branchWiseRevenue');
const getPatientBillingHistoryReport = require('./patientBillingHistory');
const getRevenueByConsultantReport = require('./revenueByConsultant');
const getRevenueByMedicineReport = require('./revenueByMedicine');
const AppError = require('../../../utils/AppError');

const BILLING_REPORTS = {
    total_revenue: getTotalRevenueReport,
    consultation_bill: getConsultationBillReport,
    medication_bill: getMedicationBillReport,
    payment_status: getPaymentStatusReport,
    pending_amount: getPendingAmountReport,
    payment_mode_collection: getPaymentModeCollectionReport,
    branch_wise_revenue: getBranchWiseRevenueReport,
    patient_billing_history: getPatientBillingHistoryReport,
    revenue_by_consultant: getRevenueByConsultantReport,
    revenue_by_medicine: getRevenueByMedicineReport,
};

const getBillingReports = async (filters, { reportKeys } = {}) => {
    // Existing report screens still receive every report. Bills Next can omit
    // reports it never displays, rather than querying and transferring them.
    let keys = Object.keys(BILLING_REPORTS);
    if (reportKeys !== undefined) {
        if (typeof reportKeys !== 'string') {
            throw new AppError('report_keys must be a comma-separated list of billing report names', 400);
        }
        keys = [...new Set(reportKeys.split(',').map((key) => key.trim()))];
        if (keys.some((key) => !Object.prototype.hasOwnProperty.call(BILLING_REPORTS, key))) {
            throw new AppError('report_keys contains an unknown billing report name', 400);
        }
    }
    const selectedFilters = reportKeys === undefined ? filters : { ...filters, includeConsultationCounts: true };
    const entries = await Promise.all(keys.map(async (key) => [key, await BILLING_REPORTS[key](selectedFilters)]));
    return Object.fromEntries(entries);
};

module.exports = {
    getBillingReports,
    getRevenueByConsultantReport,
    getRevenueByMedicineReport,
};
