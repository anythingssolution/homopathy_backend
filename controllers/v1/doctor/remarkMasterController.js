const {
    query,
    AppError,
    asyncHandler,
    normalizeMasterValue,
    UNIVERSAL_REMARK_SELECTION_VALUE,
} = require('./shared');
const { parsePagination, resolvePagination, buildPaginationMeta } = require('../../../utils/pagination');

const UNIVERSAL_REMARK_KEY = normalizeMasterValue(UNIVERSAL_REMARK_SELECTION_VALUE);

const listDoctorRemarkMaster = asyncHandler(async (req, res) => {
    const type = String(req.query.type || 'universal').trim().toLowerCase();
    const search = String(req.query.search || '').trim();

    if (!['universal', 'medicine'].includes(type)) {
        throw new AppError('type must be universal or medicine', 400);
    }

    const conditions = type === 'universal'
        ? ['normalized_selection_value = ?']
        : ["normalized_selection_value <> ''", 'normalized_selection_value <> ?'];
    const params = [UNIVERSAL_REMARK_KEY];

    if (search) {
        conditions.push('(remark_value LIKE ? OR medicine_value LIKE ? OR variant_value LIKE ?)');
        params.push(...Array(3).fill(`%${search}%`));
    }

    const { page, pageSize } = parsePagination(req.query, { defaultPageSize: 25, maxPageSize: 100 });
    const whereClause = `WHERE ${conditions.join(' AND ')}`;
    const [summary] = await query(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN is_active = 1 THEN 1 ELSE 0 END) AS active
         FROM master_text_medicine_remarks
         ${whereClause}`,
        params
    );
    const pagination = resolvePagination({ page, pageSize, total: Number(summary?.total || 0) });

    const rows = await query(
        `SELECT id, remark_value, selection_value, medicine_value, variant_value,
                is_active, created_at, updated_at
         FROM master_text_medicine_remarks
         ${whereClause}
         ORDER BY is_active DESC, updated_at DESC, remark_value ASC
         LIMIT ${pagination.pageSize} OFFSET ${pagination.offset}`,
        params
    );

    return res.status(200).json({
        success: true,
        message: 'Remark master fetched successfully',
        data: rows.map((row) => ({
            ...row,
            type,
            is_active: Boolean(row.is_active),
        })),
        meta: {
            ...buildPaginationMeta(pagination),
            type,
            active: Number(summary?.active || 0),
            inactive: Number(summary?.total || 0) - Number(summary?.active || 0),
        },
    });
});

const createDoctorRemarkMaster = asyncHandler(async (req, res) => {
    const type = String(req.body?.type || '').trim().toLowerCase();
    const remarkValue = String(req.body?.remark_value || '').trim();
    const medicineValue = String(req.body?.medicine_value || '').trim();
    const variantValue = String(req.body?.variant_value || '').trim();
    const isActive = req.body?.is_active !== false
        && req.body?.is_active !== 0
        && String(req.body?.is_active ?? '1').trim() !== '0';

    if (!['universal', 'medicine'].includes(type)) {
        throw new AppError('type must be universal or medicine', 400);
    }
    if (!remarkValue) throw new AppError('Remark is required', 400);
    if (remarkValue.length > 255) throw new AppError('Remark must be at most 255 characters', 400);
    if (type === 'medicine' && !medicineValue) throw new AppError('Medicine is required', 400);
    if (medicineValue.length > 255 || variantValue.length > 255) {
        throw new AppError('Medicine and variant must be at most 255 characters', 400);
    }

    const selectionValue = type === 'universal'
        ? UNIVERSAL_REMARK_SELECTION_VALUE
        : variantValue ? `${medicineValue} - ${variantValue}` : medicineValue;
    if (selectionValue.length > 255) throw new AppError('Medicine and variant combination is too long', 400);

    try {
        await query(
            `INSERT INTO master_text_medicine_remarks
             (remark_value, normalized_value, selection_value, normalized_selection_value,
              medicine_value, variant_value, normalized_medicine_value, normalized_variant_value, is_active)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                remarkValue,
                normalizeMasterValue(remarkValue),
                selectionValue,
                normalizeMasterValue(selectionValue),
                type === 'medicine' ? medicineValue : '',
                type === 'medicine' ? variantValue : '',
                type === 'medicine' ? normalizeMasterValue(medicineValue) : '',
                type === 'medicine' ? normalizeMasterValue(variantValue) : '',
                isActive ? 1 : 0,
            ]
        );
    } catch (error) {
        if (error?.code === 'ER_DUP_ENTRY') {
            throw new AppError('This remark already exists for the same medicine or section', 409);
        }
        throw error;
    }

    return res.status(201).json({ success: true, message: 'Remark created successfully' });
});

const updateDoctorRemarkMaster = asyncHandler(async (req, res) => {
    const remarkId = Number(req.params.remark_id);
    const remarkValue = String(req.body?.remark_value || '').trim();
    const isActive = req.body?.is_active === true
        || req.body?.is_active === 1
        || String(req.body?.is_active || '').trim() === '1';

    if (!Number.isInteger(remarkId) || remarkId <= 0) {
        throw new AppError('Valid remark_id is required', 400);
    }
    if (!remarkValue) {
        throw new AppError('Remark is required', 400);
    }
    if (remarkValue.length > 255) {
        throw new AppError('Remark must be at most 255 characters', 400);
    }

    const existingRows = await query(
        `SELECT id, normalized_selection_value
         FROM master_text_medicine_remarks
         WHERE id = ?
         LIMIT 1`,
        [remarkId]
    );
    if (!existingRows.length) {
        throw new AppError('Remark not found', 404);
    }

    try {
        await query(
            `UPDATE master_text_medicine_remarks
             SET remark_value = ?, normalized_value = ?, is_active = ?
             WHERE id = ?`,
            [remarkValue, normalizeMasterValue(remarkValue), isActive ? 1 : 0, remarkId]
        );
    } catch (error) {
        if (error?.code === 'ER_DUP_ENTRY') {
            throw new AppError('This remark already exists for the same medicine or section', 409);
        }
        throw error;
    }

    const [updated] = await query(
        `SELECT id, remark_value, selection_value, medicine_value, variant_value,
                is_active, created_at, updated_at
         FROM master_text_medicine_remarks
         WHERE id = ?`,
        [remarkId]
    );

    return res.status(200).json({
        success: true,
        message: 'Remark updated successfully',
        data: { ...updated, is_active: Boolean(updated.is_active) },
    });
});

module.exports = {
    listDoctorRemarkMaster,
    createDoctorRemarkMaster,
    updateDoctorRemarkMaster,
};
