const AppError = require('../../../utils/AppError');

const isValidDateString = (value) => /^\d{4}-\d{2}-\d{2}$/.test(value);

const toPositiveInt = (value) => {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

const parseReportFilters = (req) => {
    const fromDate = req.query.from ? String(req.query.from).trim() : null;
    const toDate = req.query.to ? String(req.query.to).trim() : null;
    const branchId = req.query.branch_id !== undefined ? toPositiveInt(req.query.branch_id) : null;

    if (!fromDate || !toDate) {
        throw new AppError('from and to are required in YYYY-MM-DD format', 400);
    }

    if (!isValidDateString(fromDate)) {
        throw new AppError('from must be in YYYY-MM-DD format', 400);
    }

    if (!isValidDateString(toDate)) {
        throw new AppError('to must be in YYYY-MM-DD format', 400);
    }

    if (fromDate > toDate) {
        throw new AppError('from must be less than or equal to to', 400);
    }

    if (req.query.branch_id !== undefined && !branchId) {
        throw new AppError('branch_id must be a positive integer', 400);
    }

    return {
        fromDate,
        toDate,
        branchId,
    };
};

const buildReportResponseMeta = ({ filters, reports }) => ({
    filters: {
        from: filters.fromDate,
        to: filters.toDate,
        branch_id: filters.branchId,
    },
    report_keys: Object.keys(reports),
});

module.exports = {
    buildReportResponseMeta,
    parseReportFilters,
};
