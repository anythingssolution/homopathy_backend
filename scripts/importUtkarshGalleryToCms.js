#!/usr/bin/env node

require('dotenv').config();

const fs = require('fs/promises');
const path = require('path');
const { pool, query } = require('../config/db');
const { uploadCmsImageAsset } = require('../services/cmsMediaStorageService');

const DEFAULT_SOURCE_DIR = path.resolve(__dirname, '../../utkarsh_gallery');
const DEFAULT_JSON_PATH = path.join(DEFAULT_SOURCE_DIR, 'gallary.json');
const DEFAULT_IMAGE_DIR = path.join(DEFAULT_SOURCE_DIR, 'gallery');

const args = new Set(process.argv.slice(2));
const isDryRun = args.has('--dry-run');
const shouldTruncate = args.has('--truncate-gallery');

const getArgValue = (name, fallback) => {
    const prefix = `${name}=`;
    const match = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
    return match ? match.slice(prefix.length) : fallback;
};

const sourceJsonPath = path.resolve(getArgValue('--json', DEFAULT_JSON_PATH));
const imageDir = path.resolve(getArgValue('--images', DEFAULT_IMAGE_DIR));

const safeJsonParse = (value, fallback) => {
    try {
        return JSON.parse(value);
    } catch (_error) {
        return fallback;
    }
};

const normalizeTitle = (value, fallback) => {
    const title = String(value || '').trim();
    return title || fallback;
};

const mapCategory = (stype) => {
    const normalized = String(stype || '').trim().toLowerCase();
    if (normalized === 'treatement') return 'TREATMENT';
    if (normalized === 'treatment') return 'TREATMENT';
    if (normalized === 'awards') return 'AWARDS';
    if (normalized === 'video') return 'VIDEO';
    return 'MEDIA';
};

const buildFileObject = async (filename) => {
    const fullPath = path.join(imageDir, filename);
    const buffer = await fs.readFile(fullPath);

    return {
        originalname: filename,
        buffer,
        size: buffer.length,
    };
};

const insertGalleryItem = async (payload) => {
    const columns = Object.keys(payload);
    const values = Object.values(payload);
    const result = await query(
        `INSERT INTO cms_gallery_items
         (${columns.join(', ')})
         VALUES (${columns.map(() => '?').join(', ')})`,
        values
    );
    return result.insertId;
};

const findExistingGalleryItem = async ({ category, mediaType, title, displayDate, sortOrder }) => {
    const rows = await query(
        `SELECT id, image_key, video_url
         FROM cms_gallery_items
         WHERE category = ?
           AND media_type = ?
           AND title = ?
           AND (display_date <=> ?)
           AND sort_order = ?
         LIMIT 1`,
        [category, mediaType, title, displayDate || null, sortOrder]
    );

    return rows[0] || null;
};

const importImageItem = async ({ sourceRow, imageName, imageIndex, sortOrder }) => {
    const category = mapCategory(sourceRow.stype);
    const title = normalizeTitle(sourceRow.stitle, `${category} ${sourceRow.sno || sortOrder}`);
    const displayDate = sourceRow.sdate || null;

    const existing = !isDryRun
        ? await findExistingGalleryItem({
            category,
            mediaType: 'IMAGE',
            title,
            displayDate,
            sortOrder,
        })
        : null;

    if (existing) {
        return {
            id: existing.id,
            type: 'image',
            imageName,
            category,
            title,
            sortOrder,
            skippedUpload: true,
            reason: 'Already imported',
            image_key: existing.image_key,
        };
    }

    if (isDryRun) {
        return {
            type: 'image',
            imageName,
            category,
            title,
            sortOrder,
            dryRun: true,
        };
    }

    const file = await buildFileObject(imageName);
    const uploaded = await uploadCmsImageAsset({ file, section: 'gallery' });
    const {
        image_mime_type: imageMimeType,
        image_size: imageSize,
        ...cmsFields
    } = uploaded.cms_fields;

    const payload = {
        category,
        media_type: 'IMAGE',
        title,
        description: null,
        ...cmsFields,
        file_mime_type: imageMimeType,
        file_size: imageSize,
        display_date: displayDate,
        sort_order: sortOrder,
        is_active: 1,
        created_by: null,
        updated_by: null,
    };

    const id = await insertGalleryItem(payload);
    return {
        id,
        type: 'image',
        imageName,
        category,
        title,
        sortOrder,
        image_key: payload.image_key,
    };
};

const importVideoItem = async ({ sourceRow, sortOrder }) => {
    const video = safeJsonParse(sourceRow.simg, {});
    const videoUrl = video.vurl || null;
    const videoId = video.vvid || null;
    const title = normalizeTitle(sourceRow.stitle, videoId ? `Video ${videoId}` : `Video ${sourceRow.sno || sortOrder}`);
    const displayDate = sourceRow.sdate || null;

    if (!videoUrl) {
        return { type: 'video', skipped: true, reason: 'Missing video URL', sortOrder };
    }

    const existing = !isDryRun
        ? await findExistingGalleryItem({
            category: 'VIDEO',
            mediaType: 'VIDEO',
            title,
            displayDate,
            sortOrder,
        })
        : null;

    if (existing) {
        return {
            id: existing.id,
            type: 'video',
            videoUrl,
            title,
            sortOrder,
            skippedUpload: true,
            reason: 'Already imported',
        };
    }

    if (isDryRun) {
        return { type: 'video', videoUrl, title, sortOrder, dryRun: true };
    }

    const id = await insertGalleryItem({
        category: 'VIDEO',
        media_type: 'VIDEO',
        title,
        description: videoId ? `YouTube video ID: ${videoId}` : null,
        image_url: null,
        image_key: null,
        image_original_url: null,
        image_original_key: null,
        thumb_url: null,
        thumb_key: null,
        video_url: videoUrl,
        video_key: videoId,
        poster_url: null,
        poster_key: null,
        file_mime_type: 'video/youtube',
        file_size: null,
        image_width: null,
        image_height: null,
        video_duration_sec: null,
        display_date: displayDate,
        sort_order: sortOrder,
        is_active: 1,
        created_by: null,
        updated_by: null,
    });

    return { id, type: 'video', videoUrl, title, sortOrder };
};

const main = async () => {
    const raw = await fs.readFile(sourceJsonPath, 'utf8');
    const rows = JSON.parse(raw);

    if (!Array.isArray(rows)) {
        throw new Error('Gallery JSON must contain an array');
    }

    if (shouldTruncate && !isDryRun) {
        await query('TRUNCATE TABLE cms_gallery_items');
    }

    const results = [];
    let sortOrder = 0;

    for (const row of rows) {
        if (String(row.stype || '').trim().toLowerCase() === 'video') {
            sortOrder += 1;
            results.push(await importVideoItem({ sourceRow: row, sortOrder }));
            continue;
        }

        const images = safeJsonParse(row.simg, []);
        for (const [imageIndex, image] of images.entries()) {
            const imageName = image?.item_img;
            if (!imageName) {
                results.push({ skipped: true, reason: 'Missing item_img', source_sno: row.sno });
                continue;
            }

            sortOrder += 1;
            try {
                results.push(await importImageItem({
                    sourceRow: row,
                    imageName,
                    imageIndex,
                    sortOrder,
                }));
            } catch (error) {
                results.push({
                    skipped: true,
                    source_sno: row.sno,
                    imageName,
                    reason: error.message,
                });
            }
        }
    }

    const inserted = results.filter((item) => item.id).length;
    const skipped = results.filter((item) => item.skipped).length;
    console.log(JSON.stringify({
        success: true,
        dryRun: isDryRun,
        json: sourceJsonPath,
        images: imageDir,
        total: results.length,
        inserted,
        skipped,
        results,
    }, null, 2));
};

main()
    .catch((error) => {
        console.error(error);
        process.exitCode = 1;
    })
    .finally(async () => {
        await pool.end();
    });
