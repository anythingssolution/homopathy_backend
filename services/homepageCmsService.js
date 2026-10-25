const path = require('path');
const { query } = require('../config/db');
const AppError = require('../utils/AppError');

const TABLES = {
    hero: 'cms_hero_slides',
    testimonials: 'cms_testimonials',
    gallery: 'cms_gallery_items',
};

const ORDER_BY = {
    hero: 'sort_order ASC, id ASC',
    testimonials: 'sort_order ASC, id DESC',
    gallery: 'sort_order ASC, id ASC',
};

const TESTIMONIAL_SEED_PATH = path.join(__dirname, '../data/seed-testimonials.json');
let testimonialSeedPromise = null;

const queryOptional = async (sql, params = []) => {
    try {
        return await query(sql, params);
    } catch (error) {
        if (error?.code === 'ER_NO_SUCH_TABLE') {
            return [];
        }
        throw error;
    }
};

const ensureSection = (section) => {
    if (!TABLES[section]) {
        throw new AppError('Unsupported CMS section', 400);
    }
};

const safeJsonParse = (value, fallback = []) => {
    if (!value) {
        return fallback;
    }

    try {
        return JSON.parse(value);
    } catch (_error) {
        return fallback;
    }
};

const normalizeOptionalText = (value) => {
    const normalized = String(value || '').trim();
    return normalized || null;
};

const normalizeOptionalNumber = (value) => {
    if (value === undefined || value === null || value === '') {
        return null;
    }

    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
};

const normalizeFlag = (value, fallback = 1) => (
    value === undefined ? fallback : Number(Boolean(value))
);

const buildHeroRow = (item) => ({
    ...item,
    image_url: item.image_url || item.image_original_url || null,
});

const buildTestimonialRow = (item) => ({
    ...item,
    image_url: item.image_url || item.image_original_url || null,
    tags: Array.isArray(item.tags)
        ? item.tags
        : Array.isArray(item.tags_json)
            ? item.tags_json
            : safeJsonParse(item.tags_json, []),
});

const buildGalleryRow = (item) => ({
    ...item,
    image_url: item.image_url || item.poster_url || item.image_original_url || null,
});

const seedTestimonialsIfEmpty = async () => {
    if (testimonialSeedPromise) return testimonialSeedPromise;
    testimonialSeedPromise = (async () => {
        const counts = await queryOptional(`SELECT COUNT(*) AS total FROM ${TABLES.testimonials}`);
        if (!counts.length || Number(counts[0]?.total || 0) > 0) return;
        let catalog = [];
        try {
            catalog = require(TESTIMONIAL_SEED_PATH);
        } catch (_error) {
            catalog = [];
        }
        for (const item of catalog) {
            const data = validateTestimonialPayload(item);
            const columns = Object.keys(data);
            await query(
                `INSERT INTO ${TABLES.testimonials}
                 (${columns.join(', ')}, created_by, updated_by)
                 VALUES (${columns.map(() => '?').join(', ')}, ?, ?)`,
                [...Object.values(data), null, null]
            );
        }
    })();
    try {
        await testimonialSeedPromise;
    } finally {
        testimonialSeedPromise = null;
    }
};

const getHomepageCmsPayload = async ({ onlyActive = true } = {}) => {
    await seedTestimonialsIfEmpty();
    const activeFilter = onlyActive ? 'WHERE is_active = 1' : '';
    const [hero, testimonials, gallery] = await Promise.all([
        queryOptional(
            `SELECT
                id, title, subtitle, cta_text, cta_link,
                image_url, image_key, image_original_url, image_original_key,
                image_mime_type, image_size, image_width, image_height,
                sort_order, is_active, created_at, updated_at
             FROM ${TABLES.hero}
             ${activeFilter}
             ORDER BY ${ORDER_BY.hero}`
        ),
        queryOptional(
            `SELECT
                id, person_name, person_title, testimonial_text,
                image_url, image_key, image_original_url, image_original_key,
                image_mime_type, image_size, image_width, image_height,
                tags_json, DATE_FORMAT(display_date, '%Y-%m-%d') AS display_date,
                sort_order, is_active, created_at, updated_at
             FROM ${TABLES.testimonials}
             ${activeFilter}
             ORDER BY ${ORDER_BY.testimonials}`
        ),
        queryOptional(
            `SELECT
                id, category, media_type, title, description,
                image_url, image_key, image_original_url, image_original_key,
                thumb_url, thumb_key,
                video_url, video_key,
                poster_url, poster_key,
                file_mime_type, file_size, image_width, image_height, video_duration_sec,
                display_date, sort_order, is_active, created_at, updated_at
             FROM ${TABLES.gallery}
             ${activeFilter}
             ORDER BY ${ORDER_BY.gallery}`
        ),
    ]);

    return {
        hero: hero.map(buildHeroRow),
        testimonials: testimonials.map(buildTestimonialRow),
        gallery: gallery.map(buildGalleryRow),
    };
};

const listCmsSection = async (section) => {
    ensureSection(section);
    return getHomepageCmsPayload({ onlyActive: false }).then((payload) => payload[section]);
};

const listPublicGallery = async ({ category = null } = {}) => {
    const normalizedCategory = normalizeOptionalText(category)?.toUpperCase();
    const params = [];
    let categoryFilter = '';

    if (normalizedCategory) {
        categoryFilter = 'AND category = ?';
        params.push(normalizedCategory);
    }

    const rows = await queryOptional(
        `SELECT
            id, category, media_type, title, description,
            image_url, image_key, image_original_url, image_original_key,
            thumb_url, thumb_key,
            video_url, video_key,
            poster_url, poster_key,
            file_mime_type, file_size, image_width, image_height, video_duration_sec,
            display_date, sort_order, is_active, created_at, updated_at
         FROM ${TABLES.gallery}
         WHERE is_active = 1
         ${categoryFilter}
         ORDER BY ${ORDER_BY.gallery}`,
        params
    );

    return rows.map(buildGalleryRow);
};

const mapSharedImageFields = (payload = {}) => ({
    image_url: normalizeOptionalText(payload.image_url),
    image_key: normalizeOptionalText(payload.image_key),
    image_original_url: normalizeOptionalText(payload.image_original_url),
    image_original_key: normalizeOptionalText(payload.image_original_key),
    image_mime_type: normalizeOptionalText(payload.image_mime_type),
    image_size: normalizeOptionalNumber(payload.image_size),
    image_width: normalizeOptionalNumber(payload.image_width),
    image_height: normalizeOptionalNumber(payload.image_height),
});

const validateHeroPayload = (payload = {}) => {
    const imageFields = mapSharedImageFields(payload);
    const imageUrl = imageFields.image_url || imageFields.image_original_url;

    if (!imageUrl) {
        throw new AppError('image_url is required', 400);
    }

    return {
        title: normalizeOptionalText(payload.title),
        subtitle: normalizeOptionalText(payload.subtitle),
        cta_text: normalizeOptionalText(payload.cta_text),
        cta_link: normalizeOptionalText(payload.cta_link),
        ...imageFields,
        image_url: imageUrl,
        sort_order: normalizeOptionalNumber(payload.sort_order) ?? 0,
        is_active: normalizeFlag(payload.is_active),
    };
};

const validateTestimonialPayload = (payload = {}) => {
    const personName = normalizeOptionalText(payload.person_name);
    const testimonialText = normalizeOptionalText(payload.testimonial_text);

    if (!personName) {
        throw new AppError('person_name is required', 400);
    }
    if (!testimonialText) {
        throw new AppError('testimonial_text is required', 400);
    }

    const tags = Array.isArray(payload.tags)
        ? payload.tags.map((tag) => String(tag || '').trim()).filter(Boolean)
        : safeJsonParse(payload.tags_json, []).map((tag) => String(tag || '').trim()).filter(Boolean);

    const imageFields = mapSharedImageFields(payload);

    return {
        person_name: personName,
        person_title: normalizeOptionalText(payload.person_title),
        testimonial_text: testimonialText,
        ...imageFields,
        tags_json: JSON.stringify(tags),
        display_date: normalizeOptionalText(payload.display_date),
        sort_order: normalizeOptionalNumber(payload.sort_order) ?? 0,
        is_active: normalizeFlag(payload.is_active),
    };
};

const PHOTO_GALLERY_CATEGORIES = new Set(['TREATMENT', 'MEDIA', 'AWARDS']);

const parseYoutubeVideo = (url) => {
    const raw = String(url || '').trim();
    if (!raw) return null;

    let parsed;
    try {
        parsed = new URL(raw.startsWith('http') ? raw : `https://${raw}`);
    } catch (_error) {
        return null;
    }

    const host = parsed.hostname.replace(/^www\./, '').toLowerCase();
    let videoId = null;
    if (host === 'youtu.be') {
        videoId = parsed.pathname.replace(/^\/+/, '').split('/')[0] || null;
    } else if (host === 'youtube.com' || host.endsWith('.youtube.com')) {
        if (parsed.pathname.startsWith('/shorts/')) {
            videoId = parsed.pathname.split('/')[2] || null;
        } else if (parsed.pathname.startsWith('/embed/')) {
            videoId = parsed.pathname.split('/')[2] || null;
        } else {
            videoId = parsed.searchParams.get('v') || null;
        }
    }

    if (!videoId || !/^[a-zA-Z0-9_-]{6,}$/.test(videoId)) {
        return null;
    }

    return {
        videoId,
        videoUrl: `https://www.youtube.com/watch?v=${videoId}`,
        posterUrl: `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`,
    };
};

const validateGalleryPayload = (payload = {}) => {
    const category = normalizeOptionalText(payload.category)?.toUpperCase() || 'MEDIA';
    const title = normalizeOptionalText(payload.title);
    let mediaType = String(payload.media_type || 'IMAGE').trim().toUpperCase();

    if (!title) {
        throw new AppError('title is required', 400);
    }
    if (category === 'VIDEO') {
        mediaType = 'VIDEO';
    } else if (PHOTO_GALLERY_CATEGORIES.has(category)) {
        mediaType = 'IMAGE';
    }
    if (!['IMAGE', 'VIDEO'].includes(mediaType)) {
        throw new AppError('media_type must be IMAGE or VIDEO', 400);
    }
    if (mediaType === 'VIDEO' && category !== 'VIDEO') {
        throw new AppError('Only the VIDEO category can use a YouTube link', 400);
    }
    if (mediaType === 'IMAGE' && category === 'VIDEO') {
        throw new AppError('VIDEO category requires a YouTube link, not a photo', 400);
    }

    const imageUrl = normalizeOptionalText(payload.image_url);
    const imageKey = normalizeOptionalText(payload.image_key);
    const imageOriginalUrl = normalizeOptionalText(payload.image_original_url);
    const imageOriginalKey = normalizeOptionalText(payload.image_original_key);
    const thumbUrl = normalizeOptionalText(payload.thumb_url);
    const thumbKey = normalizeOptionalText(payload.thumb_key);
    const videoUrl = normalizeOptionalText(payload.video_url);
    const videoKey = normalizeOptionalText(payload.video_key);
    const posterUrl = normalizeOptionalText(payload.poster_url);
    const posterKey = normalizeOptionalText(payload.poster_key);

    if (mediaType === 'IMAGE' && !(imageUrl || imageOriginalUrl)) {
        throw new AppError('A photo is required for Treatment, Media, and Awards', 400);
    }

    let resolvedVideoUrl = videoUrl;
    let resolvedVideoKey = videoKey;
    let resolvedPosterUrl = posterUrl || imageUrl;
    let resolvedPosterKey = posterKey || imageKey;
    let resolvedImageUrl = imageUrl || posterUrl || imageOriginalUrl;

    if (mediaType === 'VIDEO') {
        const youtube = parseYoutubeVideo(videoUrl);
        if (!youtube) {
            throw new AppError('Paste a valid YouTube link for VIDEO', 400);
        }
        resolvedVideoUrl = youtube.videoUrl;
        resolvedVideoKey = youtube.videoId;
        resolvedPosterUrl = youtube.posterUrl;
        resolvedImageUrl = youtube.posterUrl;
    }

    return {
        category,
        media_type: mediaType,
        title,
        description: normalizeOptionalText(payload.description),
        image_url: resolvedImageUrl,
        image_key: imageKey || posterKey,
        image_original_url: imageOriginalUrl,
        image_original_key: imageOriginalKey,
        thumb_url: thumbUrl,
        thumb_key: thumbKey,
        video_url: resolvedVideoUrl,
        video_key: resolvedVideoKey,
        poster_url: resolvedPosterUrl,
        poster_key: resolvedPosterKey,
        file_mime_type: normalizeOptionalText(payload.file_mime_type),
        file_size: normalizeOptionalNumber(payload.file_size),
        image_width: normalizeOptionalNumber(payload.image_width),
        image_height: normalizeOptionalNumber(payload.image_height),
        video_duration_sec: normalizeOptionalNumber(payload.video_duration_sec),
        display_date: normalizeOptionalText(payload.display_date),
        sort_order: normalizeOptionalNumber(payload.sort_order) ?? 0,
        is_active: normalizeFlag(payload.is_active),
    };
};

const VALIDATORS = {
    hero: validateHeroPayload,
    testimonials: validateTestimonialPayload,
    gallery: validateGalleryPayload,
};

const createCmsSectionItem = async (section, payload, userId = null) => {
    ensureSection(section);
    const data = VALIDATORS[section](payload);
    const columns = Object.keys(data);
    const values = Object.values(data);

    const result = await query(
        `INSERT INTO ${TABLES[section]}
         (${columns.join(', ')}, created_by, updated_by)
         VALUES (${columns.map(() => '?').join(', ')}, ?, ?)`,
        [...values, userId, userId]
    );

    return listCmsSection(section).then((rows) => rows.find((row) => Number(row.id) === Number(result.insertId)) || null);
};

const updateCmsSectionItem = async (section, id, payload, userId = null) => {
    ensureSection(section);
    const itemId = Number(id);

    if (!Number.isInteger(itemId) || itemId <= 0) {
        throw new AppError('Valid id is required', 400);
    }

    const data = VALIDATORS[section](payload);
    const entries = Object.entries(data);
    const result = await query(
        `UPDATE ${TABLES[section]}
         SET ${entries.map(([column]) => `${column} = ?`).join(', ')},
             updated_by = ?,
             updated_at = NOW()
         WHERE id = ?`,
        [...entries.map(([, value]) => value), userId, itemId]
    );

    if (!result.affectedRows) {
        throw new AppError('CMS item not found', 404);
    }

    return listCmsSection(section).then((rows) => rows.find((row) => Number(row.id) === itemId) || null);
};

const removeCmsSectionItem = async (section, id) => {
    ensureSection(section);
    const itemId = Number(id);

    if (!Number.isInteger(itemId) || itemId <= 0) {
        throw new AppError('Valid id is required', 400);
    }

    const result = await query(`DELETE FROM ${TABLES[section]} WHERE id = ?`, [itemId]);
    if (!result.affectedRows) {
        throw new AppError('CMS item not found', 404);
    }
};

module.exports = {
    getHomepageCmsPayload,
    listPublicGallery,
    listCmsSection,
    createCmsSectionItem,
    updateCmsSectionItem,
    removeCmsSectionItem,
};
