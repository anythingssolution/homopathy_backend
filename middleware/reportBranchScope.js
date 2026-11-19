const { query } = require('../config/db');
const AppError = require('../utils/AppError');
const { enforceSelectedBranchScope } = require('./authMiddleware');

// Opt-in report scope preserves the working-branch contract of Bills Next and
// existing report API consumers. It never updates master_users.selected_branch_id.
const enforceReportBranchScope = async (req, res, next) => {
    if (req.query.report_scope !== 'independent') {
        if (req.query.branch_id !== undefined && !/^[1-9]\d*$/.test(String(req.query.branch_id))) {
            return next(new AppError('branch_id must be a positive integer', 400));
        }
        return enforceSelectedBranchScope(req, res, next);
    }
    try {
        const raw = req.query.branch_id;
        const all = raw === undefined || raw === 'all';
        const id = all ? null : Number(raw);
        if (!all && (typeof raw !== 'string' || !/^\d+$/.test(raw) || !Number.isSafeInteger(id) || id <= 0)) {
            throw new AppError('branch_id must be all or a positive integer', 400);
        }
        const branches = await query(`SELECT b.id, b.branch_name,
            EXISTS (SELECT 1 FROM tbl_user_branch_access uba
                WHERE uba.user_id = ? AND uba.branch_id = b.id AND uba.is_active = 1) AS has_access
            FROM master_clinic_branches b WHERE b.is_active = 1 ORDER BY b.branch_name`, [req.user.id]);
        const available = branches.filter(branch => Number(branch.has_access) === 1);
        if (!available.length || (id && !available.some(branch => Number(branch.id) === id))) {
            throw new AppError('You do not have access to this report branch', 403);
        }
        req.reportScope = {
            branchId: id,
            branchIds: id ? [id] : available.map(branch => Number(branch.id)),
            allClinicBranches: all && available.length === branches.length,
            availableBranches: available.map(branch => ({ id: Number(branch.id), branch_name: branch.branch_name })),
        };
        return next();
    } catch (error) { return next(error); }
};

// Read-only drilldowns are checked against the report's authorized branch set.
// The existing entity controllers may then use that entity's branch for reads.
const authorizeReportEntity = (kind) => async (req, _res, next) => {
    try {
        const id = Number(req.params[`${kind}_id`]);
        if (!Number.isSafeInteger(id) || id <= 0) throw new AppError(`Valid ${kind}_id is required`, 400);
        const lookups = {
            appointment: 'SELECT fk_branch_id FROM tbl_appointments WHERE appointment_id = ?',
            consultation: 'SELECT a.fk_branch_id FROM tbl_consultations c JOIN tbl_appointments a ON a.appointment_id=c.appointment_id WHERE c.id = ?',
            bill: 'SELECT fk_branch_id FROM tbl_bills WHERE id = ?',
        };
        const [row] = await query(lookups[kind], [id]);
        if (!row) throw new AppError('Report record not found', 404);
        const allowed = req.reportScope?.branchIds || [req.selectedBranchId];
        if (!allowed.includes(Number(row.fk_branch_id))) throw new AppError('You do not have access to this report record', 403);
        req.selectedBranchId = Number(row.fk_branch_id);
        return next();
    } catch (error) { return next(error); }
};

module.exports = { enforceReportBranchScope, authorizeReportEntity };
