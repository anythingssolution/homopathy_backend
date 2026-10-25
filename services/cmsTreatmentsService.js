const path = require('path');
const { query } = require('../config/db');
const AppError = require('../utils/AppError');

const TABLE = 'cms_treatments';
const SEED_PATH = path.join(__dirname, '../data/seed-treatments.json');

let seedPromise = null;

const slugify = (value) => String(value || '')
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);

const normalizeOptionalText = (value) => {
    const normalized = String(value || '').trim();
    return normalized || null;
};

const normalizeOptionalNumber = (value) => {
    if (value === undefined || value === null || value === '') return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
};

const normalizeFlag = (value, fallback = 1) => (
    value === undefined ? fallback : Number(Boolean(value))
);

const parseRemedies = (payload = {}) => {
    if (Array.isArray(payload.remedies)) {
        return payload.remedies.map((item) => String(item || '').trim()).filter(Boolean);
    }
    if (typeof payload.remedies === 'string') {
        return payload.remedies.split(',').map((item) => item.trim()).filter(Boolean);
    }
    try {
        const parsed = JSON.parse(payload.remedies_json || '[]');
        return Array.isArray(parsed) ? parsed.map((item) => String(item || '').trim()).filter(Boolean) : [];
    } catch (_error) {
        return [];
    }
};

const buildTreatmentRow = (item) => {
    if (!item) return null;
    let remedies = [];
    try {
        remedies = JSON.parse(item.remedies_json || '[]');
    } catch (_error) {
        remedies = [];
    }
    return {
        ...item,
        remedies: Array.isArray(remedies) ? remedies : [],
        public_path: `/treatments/${item.slug}`,
    };
};

const queryTreatments = async (sql, params = []) => {
    try {
        return await query(sql, params);
    } catch (error) {
        if (error?.code === 'ER_NO_SUCH_TABLE') {
            throw new AppError('cms_treatments table is missing. Run the 2026-10-25 treatment CMS SQL first.', 500);
        }
        throw error;
    }
};

const seedCatalogIfEmpty = async () => {
    if (seedPromise) return seedPromise;
    seedPromise = (async () => {
        const counts = await queryTreatments(`SELECT COUNT(*) AS total FROM ${TABLE}`);
        if (Number(counts[0]?.total || 0) > 0) return;
        let catalog = [];
        try {
            catalog = require(SEED_PATH);
        } catch (_error) {
            catalog = [];
        }
        for (const item of catalog) {
            try {
                await createTreatment(item, null);
            } catch (error) {
                if (!String(error.message || '').toLowerCase().includes('already used')) {
                    throw error;
                }
            }
        }
    })();
    try {
        await seedPromise;
    } finally {
        seedPromise = null;
    }
};

const listTreatments = async ({ onlyActive = false } = {}) => {
    await seedCatalogIfEmpty();
    const rows = await queryTreatments(
        `SELECT
            id, slug, title_en, title_hi, category, description,
            image_url, image_key, seo_title, seo_description, remedies_json,
            sort_order, is_active, created_at, updated_at
         FROM ${TABLE}
         ${onlyActive ? 'WHERE is_active = 1' : ''}
         ORDER BY sort_order ASC, id DESC`
    );
    return rows.map(buildTreatmentRow);
};

const getTreatmentById = async (id) => {
    const itemId = Number(id);
    if (!Number.isInteger(itemId) || itemId <= 0) {
        throw new AppError('Valid id is required', 400);
    }
    const rows = await queryTreatments(
        `SELECT
            id, slug, title_en, title_hi, category, description,
            image_url, image_key, seo_title, seo_description, remedies_json,
            sort_order, is_active, created_at, updated_at
         FROM ${TABLE}
         WHERE id = ?
         LIMIT 1`,
        [itemId]
    );
    return buildTreatmentRow(rows[0]);
};

const validateTreatmentPayload = async (payload = {}, { currentId = null } = {}) => {
    const titleEn = normalizeOptionalText(payload.title_en);
    const description = normalizeOptionalText(payload.description);
    const requestedSlug = slugify(payload.slug || payload.title_en);

    if (!titleEn) {
        throw new AppError('English title is required', 400);
    }
    if (!description) {
        throw new AppError('Description is required', 400);
    }
    if (!requestedSlug || requestedSlug.length < 3) {
        throw new AppError('SEO URL must be at least 3 characters, like diabetes-treatment', 400);
    }
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(requestedSlug)) {
        throw new AppError('SEO URL can only use lowercase letters, numbers, and hyphens', 400);
    }

    const duplicates = await queryTreatments(
        `SELECT id FROM ${TABLE} WHERE slug = ? ${currentId ? 'AND id <> ?' : ''} LIMIT 1`,
        currentId ? [requestedSlug, currentId] : [requestedSlug]
    );
    if (duplicates.length) {
        throw new AppError('That SEO URL is already used by another CMS treatment', 400);
    }

    const seoTitle = normalizeOptionalText(payload.seo_title) || `${titleEn} Treatment in Raipur | Dr. Trivedi's Homeopathy`;
    const seoDescription = normalizeOptionalText(payload.seo_description)
        || `Homeopathic ${titleEn.toLowerCase()} treatment in Raipur at Dr. Trivedi's Homeopathy Clinic. ${description}`.slice(0, 320);

    return {
        slug: requestedSlug,
        title_en: titleEn,
        title_hi: normalizeOptionalText(payload.title_hi),
        category: normalizeOptionalText(payload.category) || 'Specialty',
        description,
        image_url: normalizeOptionalText(payload.image_url),
        image_key: normalizeOptionalText(payload.image_key),
        seo_title: seoTitle,
        seo_description: seoDescription,
        remedies_json: JSON.stringify(parseRemedies(payload)),
        sort_order: normalizeOptionalNumber(payload.sort_order) ?? 0,
        is_active: normalizeFlag(payload.is_active),
    };
};

const createTreatment = async (payload, userId = null) => {
    const data = await validateTreatmentPayload(payload);
    const columns = Object.keys(data);
    const result = await queryTreatments(
        `INSERT INTO ${TABLE}
         (${columns.join(', ')}, created_by, updated_by)
         VALUES (${columns.map(() => '?').join(', ')}, ?, ?)`,
        [...Object.values(data), userId, userId]
    );
    return getTreatmentById(result.insertId);
};

const updateTreatment = async (id, payload, userId = null) => {
    const itemId = Number(id);
    if (!Number.isInteger(itemId) || itemId <= 0) {
        throw new AppError('Valid id is required', 400);
    }
    const data = await validateTreatmentPayload(payload, { currentId: itemId });
    const entries = Object.entries(data);
    const result = await queryTreatments(
        `UPDATE ${TABLE}
         SET ${entries.map(([column]) => `${column} = ?`).join(', ')},
             updated_by = ?,
             updated_at = NOW()
         WHERE id = ?`,
        [...entries.map(([, value]) => value), userId, itemId]
    );
    if (!result.affectedRows) {
        throw new AppError('Treatment not found', 404);
    }
    return getTreatmentById(itemId);
};

const deleteTreatment = async (id) => {
    const itemId = Number(id);
    if (!Number.isInteger(itemId) || itemId <= 0) {
        throw new AppError('Valid id is required', 400);
    }
    const result = await queryTreatments(`DELETE FROM ${TABLE} WHERE id = ?`, [itemId]);
    if (!result.affectedRows) {
        throw new AppError('Treatment not found', 404);
    }
};

module.exports = {
    slugify,
    listTreatments,
    getTreatmentById,
    createTreatment,
    updateTreatment,
    deleteTreatment,
    seedCatalogIfEmpty,
};
