const { query, withTransaction } = require('../config/db');
const AppError = require('../utils/AppError');

const SOURCE_TYPES = new Set(['REGULAR_PRODUCT', 'RADIENT_PHARMA', 'MEDICAL_PRODUCT_PRICE', 'DOCTOR_MANUAL']);

const normalizeValue = (value) => String(value || '').trim().toLowerCase();

const normalizeString = (value) => {
    const normalized = String(value ?? '').trim();
    return normalized || null;
};

const toNullableAmount = (value, fieldName) => {
    if (value === undefined || value === null || String(value).trim() === '') {
        return null;
    }

    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) {
        throw new AppError(`${fieldName} must be a valid non-negative number`, 400);
    }

    return Number(parsed.toFixed(2));
};

const toNullableInt = (value, fieldName) => {
    if (value === undefined || value === null || String(value).trim() === '') {
        return null;
    }

    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 0) {
        throw new AppError(`${fieldName} must be a valid non-negative integer`, 400);
    }

    return parsed;
};

const toBooleanInt = (value) => {
    if (value === undefined || value === null || String(value).trim() === '') {
        return 1;
    }

    const normalized = String(value).trim().toLowerCase();
    return ['0', 'false', 'no', 'inactive'].includes(normalized) ? 0 : 1;
};

const buildDedupeKey = (product) => {
    if (product.source_type === 'REGULAR_PRODUCT') {
        return [
            product.normalized_product_name,
            normalizeValue(product.packing),
            normalizeValue(product.product_type),
        ].join('|');
    }

    if (product.source_type === 'RADIENT_PHARMA') {
        return [
            product.normalized_product_name,
            normalizeValue(product.size_or_weight),
            normalizeValue(product.category),
        ].join('|');
    }

    if (product.source_type === 'DOCTOR_MANUAL') {
        return [
            product.normalized_product_name,
            normalizeValue(product.packing),
        ].join('|');
    }

    return [
        normalizeValue(product.category),
        product.normalized_product_name,
    ].join('|');
};

const normalizeProductPayload = (payload) => {
    const sourceType = String(payload?.source_type || '').trim().toUpperCase();
    const productName = normalizeString(payload?.product_name);
    const medicineValue = normalizeString(payload?.medicine_value) || productName;

    if (!SOURCE_TYPES.has(sourceType)) {
        throw new AppError('source_type must be REGULAR_PRODUCT, RADIENT_PHARMA, MEDICAL_PRODUCT_PRICE or DOCTOR_MANUAL', 400);
    }

    if (!productName) {
        throw new AppError('product_name is required', 400);
    }

    const normalizedProduct = {
        medicine_value: medicineValue,
        normalized_medicine_value: normalizeValue(medicineValue),
        source_type: sourceType,
        product_name: productName,
        product_type: normalizeString(payload?.product_type),
        category: normalizeString(payload?.category),
        packing: normalizeString(payload?.packing),
        size_or_weight: normalizeString(payload?.size_or_weight),
        mrp_rate: toNullableAmount(payload?.mrp_rate, 'mrp_rate'),
        price_min: toNullableAmount(payload?.price_min, 'price_min'),
        price_max: toNullableAmount(payload?.price_max, 'price_max'),
        shipper_size_pcs: toNullableInt(payload?.shipper_size_pcs, 'shipper_size_pcs'),
        description: normalizeString(payload?.description),
        formula_composition: normalizeString(payload?.formula_composition),
        normalized_category: normalizeValue(payload?.category),
        normalized_product_name: normalizeValue(productName),
        is_active: toBooleanInt(payload?.is_active),
    };

    normalizedProduct.dedupe_key = buildDedupeKey(normalizedProduct);
    return normalizedProduct;
};

const assertUniqueProductVariant = async (product, excludeId = null) => {
    const params = [product.source_type, product.dedupe_key];
    let excludeCondition = '';

    if (excludeId) {
        excludeCondition = ' AND id <> ?';
        params.push(excludeId);
    }

    const rows = await query(
        `SELECT id, product_name, packing, size_or_weight, source_type
         FROM master_medical_products
         WHERE source_type = ?
           AND dedupe_key = ?${excludeCondition}
         LIMIT 1`,
        params
    );

    if (rows.length > 0) {
        const variant = rows[0].packing || rows[0].size_or_weight || rows[0].source_type;
        throw new AppError(`Product variant already exists as "${rows[0].product_name}"${variant ? ` (${variant})` : ''}`, 409);
    }
};

const upsertMedicineMaster = async (connection, product) => {
    const [result] = await connection.execute(
        `INSERT INTO master_text_medicines
         (medicine_value, normalized_value, is_active)
         VALUES (?, ?, 1)
         ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id), updated_at = CURRENT_TIMESTAMP`,
        [product.medicine_value, product.normalized_medicine_value]
    );

    return result.insertId;
};

const listMedicalProducts = async ({
    page = 1,
    limit = 20,
    search = '',
    sourceType = '',
    status = 'all',
}) => {
    const safePage = Math.max(Number(page) || 1, 1);
    const safeLimit = Math.min(Math.max(Number(limit) || 20, 1), 100);
    const offset = (safePage - 1) * safeLimit;
    const where = [];
    const params = [];

    if (search) {
        where.push(`(
            mmp.product_name LIKE ?
            OR mmp.category LIKE ?
            OR mmp.product_type LIKE ?
            OR mtm.medicine_value LIKE ?
        )`);
        const searchLike = `%${search}%`;
        params.push(searchLike, searchLike, searchLike, searchLike);
    }

    const normalizedSourceType = String(sourceType || '').trim().toUpperCase();
    if (normalizedSourceType) {
        if (!SOURCE_TYPES.has(normalizedSourceType)) {
            throw new AppError('source_type must be REGULAR_PRODUCT, RADIENT_PHARMA, MEDICAL_PRODUCT_PRICE or DOCTOR_MANUAL', 400);
        }
        where.push('mmp.source_type = ?');
        params.push(normalizedSourceType);
    }

    const normalizedStatus = String(status || 'all').trim().toLowerCase();
    if (normalizedStatus === 'active') {
        where.push('mmp.is_active = 1');
    } else if (normalizedStatus === 'inactive') {
        where.push('mmp.is_active = 0');
    } else if (normalizedStatus !== 'all') {
        throw new AppError('status must be all, active or inactive', 400);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const countRows = await query(
        `SELECT COUNT(*) AS total
         FROM master_medical_products mmp
         LEFT JOIN master_text_medicines mtm ON mtm.id = mmp.medicine_text_id
         ${whereSql}`,
        params
    );

    const rows = await query(
        `SELECT
            mmp.id,
            mmp.medicine_text_id,
            COALESCE(mtm.medicine_value, '') AS medicine_value,
            mmp.source_type,
            mmp.product_name,
            mmp.product_type,
            mmp.category,
            mmp.packing,
            mmp.size_or_weight,
            mmp.mrp_rate,
            mmp.price_min,
            mmp.price_max,
            mmp.shipper_size_pcs,
            mmp.description,
            mmp.formula_composition,
            mmp.is_active,
            mmp.created_at,
            mmp.updated_at
         FROM master_medical_products mmp
         LEFT JOIN master_text_medicines mtm ON mtm.id = mmp.medicine_text_id
         ${whereSql}
         ORDER BY (TRIM(mmp.product_name) REGEXP '^[0-9]') ASC, mmp.product_name ASC, mmp.id ASC
         LIMIT ? OFFSET ?`,
        [...params, safeLimit, offset]
    );

    return {
        rows,
        pagination: {
            page: safePage,
            limit: safeLimit,
            total: Number(countRows[0]?.total || 0),
            total_pages: Math.ceil(Number(countRows[0]?.total || 0) / safeLimit),
        },
    };
};

const getMedicalProductById = async (id) => {
    const rows = await query(
        `SELECT
            mmp.id,
            mmp.medicine_text_id,
            COALESCE(mtm.medicine_value, '') AS medicine_value,
            mmp.source_type,
            mmp.product_name,
            mmp.product_type,
            mmp.category,
            mmp.packing,
            mmp.size_or_weight,
            mmp.mrp_rate,
            mmp.price_min,
            mmp.price_max,
            mmp.shipper_size_pcs,
            mmp.description,
            mmp.formula_composition,
            mmp.is_active,
            mmp.created_at,
            mmp.updated_at
         FROM master_medical_products mmp
         LEFT JOIN master_text_medicines mtm ON mtm.id = mmp.medicine_text_id
         WHERE mmp.id = ?
         LIMIT 1`,
        [id]
    );

    return rows[0] || null;
};

const createMedicalProduct = async (payload) => {
    const product = normalizeProductPayload(payload);
    await assertUniqueProductVariant(product);

    let productId = null;
    await withTransaction(async (connection) => {
        const medicineTextId = await upsertMedicineMaster(connection, product);
        const [insertResult] = await connection.execute(
            `INSERT INTO master_medical_products
             (medicine_text_id, source_type, product_name, product_type, category,
              packing, size_or_weight, mrp_rate, price_min, price_max, shipper_size_pcs,
              description, formula_composition, normalized_category, normalized_product_name,
              dedupe_key, is_active)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                medicineTextId,
                product.source_type,
                product.product_name,
                product.product_type,
                product.category,
                product.packing,
                product.size_or_weight,
                product.mrp_rate,
                product.price_min,
                product.price_max,
                product.shipper_size_pcs,
                product.description,
                product.formula_composition,
                product.normalized_category,
                product.normalized_product_name,
                product.dedupe_key,
                product.is_active,
            ]
        );
        productId = insertResult.insertId;
    });

    return getMedicalProductById(productId);
};

const updateMedicalProduct = async (id, payload) => {
    const current = await getMedicalProductById(id);
    if (!current) {
        throw new AppError('Medical product not found', 404);
    }

    const product = normalizeProductPayload(payload);
    await assertUniqueProductVariant(product, id);

    await withTransaction(async (connection) => {
        const medicineTextId = await upsertMedicineMaster(connection, product);
        await connection.execute(
            `UPDATE master_medical_products
             SET medicine_text_id = ?,
                 source_type = ?,
                 product_name = ?,
                 product_type = ?,
                 category = ?,
                 packing = ?,
                 size_or_weight = ?,
                 mrp_rate = ?,
                 price_min = ?,
                 price_max = ?,
                 shipper_size_pcs = ?,
                 description = ?,
                 formula_composition = ?,
                 normalized_category = ?,
                 normalized_product_name = ?,
                 dedupe_key = ?,
                 is_active = ?
             WHERE id = ?`,
            [
                medicineTextId,
                product.source_type,
                product.product_name,
                product.product_type,
                product.category,
                product.packing,
                product.size_or_weight,
                product.mrp_rate,
                product.price_min,
                product.price_max,
                product.shipper_size_pcs,
                product.description,
                product.formula_composition,
                product.normalized_category,
                product.normalized_product_name,
                product.dedupe_key,
                product.is_active,
                id,
            ]
        );
    });

    return getMedicalProductById(id);
};

const deleteMedicalProduct = async (id) => {
    const current = await getMedicalProductById(id);
    if (!current) {
        throw new AppError('Medical product not found', 404);
    }

    await query(
        `UPDATE master_medical_products
         SET is_active = 0
         WHERE id = ?`,
        [id]
    );

    return getMedicalProductById(id);
};

const getMedicalProductSummary = async () => {
    const rows = await query(
        `SELECT
            COUNT(*) AS total,
            SUM(CASE
                WHEN CONCAT_WS(' ', product_type, category, product_name, packing, size_or_weight) REGEXP 'syrup|syp' THEN 1
                ELSE 0
            END) AS syrup,
            SUM(CASE
                WHEN CONCAT_WS(' ', product_type, category, product_name, packing, size_or_weight) REGEXP 'oil' THEN 1
                ELSE 0
            END) AS oil,
            SUM(CASE
                WHEN CONCAT_WS(' ', product_type, category, product_name, packing, size_or_weight) REGEXP 'drop|drops' THEN 1
                ELSE 0
            END) AS drop_count,
            SUM(CASE
                WHEN CONCAT_WS(' ', product_type, category, product_name, packing, size_or_weight) REGEXP 'tab|tablet|tablets' THEN 1
                ELSE 0
            END) AS tab,
            SUM(CASE
                WHEN NOT (
                    CONCAT_WS(' ', product_type, category, product_name, packing, size_or_weight) REGEXP 'syrup|syp'
                    OR CONCAT_WS(' ', product_type, category, product_name, packing, size_or_weight) REGEXP 'oil'
                    OR CONCAT_WS(' ', product_type, category, product_name, packing, size_or_weight) REGEXP 'drop|drops'
                    OR CONCAT_WS(' ', product_type, category, product_name, packing, size_or_weight) REGEXP 'tab|tablet|tablets'
                ) THEN 1
                ELSE 0
            END) AS other
         FROM master_medical_products
         WHERE is_active = 1`
    );

    const row = rows[0] || {};
    const syrup = Number(row.syrup || 0);
    const oil = Number(row.oil || 0);
    const drop = Number(row.drop_count || 0);
    const tab = Number(row.tab || 0);
    const other = Number(row.other || 0);

    return {
        total: syrup + oil + drop + tab + other,
        syrup,
        oil,
        drop,
        tab,
        other,
    };
};

module.exports = {
    listMedicalProducts,
    getMedicalProductById,
    createMedicalProduct,
    updateMedicalProduct,
    deleteMedicalProduct,
    getMedicalProductSummary,
};
