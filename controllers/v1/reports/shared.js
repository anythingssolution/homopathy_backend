const AppError = require('../../../utils/AppError');

const isValidDateString = (value) => /^\d{4}-\d{2}-\d{2}$/.test(value);

const toPositiveInt = (value) => {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

const parseReportFilters = (req) => {
    const rawFrom = req.query.from || req.query.from_date;
    const rawTo = req.query.to || req.query.to_date;

    let fromDate = rawFrom ? String(rawFrom).trim() : null;
    let toDate = rawTo ? String(rawTo).trim() : null;

    // Default to today if omitted
    const today = new Date().toISOString().split('T')[0];
    if (!fromDate) fromDate = today;
    if (!toDate) toDate = today;

    const branchId = req.reportScope ? req.reportScope.branchId
        : req.query.branch_id !== undefined && req.query.branch_id !== '' ? toPositiveInt(req.query.branch_id) : null;

    if (!isValidDateString(fromDate)) {
        throw new AppError('from/from_date must be in YYYY-MM-DD format', 400);
    }

    if (!isValidDateString(toDate)) {
        throw new AppError('to/to_date must be in YYYY-MM-DD format', 400);
    }

    if (fromDate > toDate) {
        throw new AppError('from date must be less than or equal to to date', 400);
    }

    return {
        fromDate,
        toDate,
        branchId,
        ...(req.reportScope ? { branchIds: req.reportScope.branchIds, allClinicBranches: req.reportScope.allClinicBranches } : {}),
        includeUnassigned: req.user?.role === 'doctor' && req.query.billing_scope === 'branch' && Number(req.selectedBranchId) > 0,
    };
};

const buildReportResponseMeta = ({ filters, reports, report }) => ({
    filters: {
        from: filters.fromDate,
        to: filters.toDate,
        branch_id: filters.branchId,
        ...(filters.branchIds ? { branch_ids: filters.branchIds, report_scope: 'independent' } : {}),
    },
    report_keys: reports && typeof reports === 'object' ? Object.keys(reports) : (report ? ['data'] : []),
});

module.exports = {
    buildReportResponseMeta,
    parseReportFilters,
};
