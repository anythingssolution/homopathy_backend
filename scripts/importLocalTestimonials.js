#!/usr/bin/env node
const archive = require('../data/localTestimonials');
const LOCK_NAME = 'import_local_clinic_testimonials';

async function importLocalTestimonials(connection, { apply = false, items = archive } = {}) {
    const counts = { mode: apply ? 'applied' : 'preview', images: items.length, inserted: 0, localized: 0, skipped: 0 };
    let locked = false;
    try {
        const [lock] = await connection.execute('SELECT GET_LOCK(?, 10) AS acquired', [LOCK_NAME]);
        if (Number(lock[0]?.acquired) !== 1) throw new Error('Another testimonial import is running. Retry later.');
        locked = true;
        await connection.beginTransaction();
        for (const [index, item] of items.entries()) {
            if (!/^\/site-images\/images\/testimonial-\d+\.webp$/.test(item.image_url)
                || !/^\/site-images\/originals\/testimonial-\d+\.jpg$/.test(item.original_url)) {
                throw new Error('Invalid testimonial archive path');
            }
            const originalKey = item.original_url.slice(1);
            const urls = [item.image_url, item.original_url, item.source_url, item.legacy_path,
                `https://www.drtrivedishomeopathy.in${item.legacy_path}`, `https://drtrivedishomeopathy.in${item.legacy_path}`];
            const [rows] = await connection.execute(`SELECT id, image_url FROM cms_testimonials
                WHERE image_original_key = ? OR image_original_url = ? OR image_url IN (?, ?, ?, ?, ?, ?)
                LIMIT 1 FOR UPDATE`, [originalKey, item.original_url, ...urls]);
            if (rows.length) {
                const row = rows[0];
                if (urls.slice(2).includes(row.image_url)) {
                    if (apply) await connection.execute(`UPDATE cms_testimonials
                        SET image_url = ?, image_original_url = ?, image_original_key = ? WHERE id = ?`,
                    [item.image_url, item.original_url, originalKey, row.id]);
                    counts.localized++;
                } else counts.skipped++;
                continue;
            }
            // The original review is in the image. Do not invent patient names, claims or dates.
            const label = `Patient Testimonial ${index + 1}`;
            if (apply) await connection.execute(`INSERT INTO cms_testimonials
                (person_name, testimonial_text, image_url, image_original_url, image_original_key,
                 image_mime_type, image_size, image_width, image_height, sort_order, is_active)
                VALUES (?, ?, ?, ?, ?, 'image/webp', ?, ?, ?, ?, 1)`,
            [label, label, item.image_url, item.original_url, originalKey,
                item.optimized_bytes, item.width, item.height, index + 1]);
            counts.inserted++;
        }
        if (apply) await connection.commit(); else await connection.rollback();
        return counts;
    } catch (error) {
        await connection.rollback();
        throw error;
    } finally {
        if (locked) await connection.execute('SELECT RELEASE_LOCK(?)', [LOCK_NAME]);
    }
}

if (require.main === module) {
    require('dotenv').config();
    const { pool } = require('../config/db');
    (async () => {
        const connection = await pool.getConnection();
        try { console.log(JSON.stringify(await importLocalTestimonials(connection, { apply: process.argv.includes('--apply') }), null, 2)); }
        finally { connection.release(); }
    })().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => pool.end());
}
module.exports = { importLocalTestimonials };
