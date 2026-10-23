#!/usr/bin/env node
require('dotenv').config();
const path = require('path');
const { pool } = require('../config/db');
const manifest = require('../data/legacy-gallery.json');

// Run after deploying the matching frontend/public/gallery files.
// Default is a preview; --apply inserts missing images and localizes matching legacy URLs.
const apply = process.argv.includes('--apply');
const main = async () => {
    const connection = await pool.getConnection();
    let locked = false;
    try {
        const [lock] = await connection.execute("SELECT GET_LOCK('import_local_clinic_gallery', 10) AS acquired");
        if (Number(lock[0]?.acquired) !== 1) throw new Error('Another gallery import is running. Try again later.');
        locked = true;
        await connection.beginTransaction();
        let inserted = 0, localized = 0, skipped = 0, titlesFilled = 0;
        for (const item of manifest.items) {
            if (!item.image_url.startsWith('/gallery/images/') || !item.original_url.startsWith('/gallery/originals/')) {
                throw new Error('Archive contains an invalid local image path');
            }
            const key = item.original_url.slice(1);
            const legacyUrl = `https://www.drtrivedishomeopathy.in/assets/files/gallery/${path.basename(item.original_url)}`;
            const [existing] = await connection.execute(`SELECT id, image_url, title FROM cms_gallery_items
                WHERE image_original_key = ? OR image_original_url = ? OR image_url IN (?, ?, ?)
                LIMIT 1 FOR UPDATE`, [key, item.original_url, item.image_url, item.source_url, legacyUrl]);
            if (existing.length) {
                const row = existing[0];
                if (!String(row.title || '').trim()) {
                    if (apply) await connection.execute('UPDATE cms_gallery_items SET title = ? WHERE id = ?', [item.display_title, row.id]);
                    titlesFilled++;
                }
                if ([item.source_url, legacyUrl].includes(row.image_url)) {
                    if (apply) await connection.execute(`UPDATE cms_gallery_items
                        SET image_url = ?, image_original_url = ?, image_original_key = ?, thumb_url = NULL,
                            thumb_key = NULL WHERE id = ?`, [item.image_url, item.original_url, key, row.id]);
                    localized++;
                } else skipped++;
                continue;
            }
            if (apply) await connection.execute(`INSERT INTO cms_gallery_items
                (category, media_type, title, image_url, image_original_url, image_original_key,
                 file_mime_type, file_size, image_width, image_height, sort_order, is_active)
                VALUES (?, 'IMAGE', ?, ?, ?, ?, 'image/webp', ?, ?, ?, ?, 1)`,
            [item.category, item.display_title, item.image_url, item.original_url, key,
                item.optimized_bytes, item.width, item.height, item.sort_order]);
            inserted++;
        }
        if (apply) await connection.commit(); else await connection.rollback();
        console.log(JSON.stringify({ mode: apply ? 'applied' : 'preview', images: manifest.items.length, inserted, localized, skipped, titlesFilled }, null, 2));
    } catch (error) {
        await connection.rollback();
        throw error;
    } finally {
        if (locked) await connection.execute("SELECT RELEASE_LOCK('import_local_clinic_gallery')");
        connection.release();
    }
};
main().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => pool.end());
