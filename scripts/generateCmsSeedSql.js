const fs = require('fs');
const path = require('path');

const treatments = require('../data/seed-treatments.json');
const testimonials = require('../data/seed-testimonials.json');
const outputPath = path.resolve(__dirname, '../sql/2026-10-25_cms_treatments_testimonials_seed.sql');

const sqlString = (value) => {
    if (value === null || value === undefined || value === '') return 'NULL';
    return `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;
};

const testimonialAssetPath = (imageUrl, index) => {
    const match = String(imageUrl || '').match(/testimonial-(\d+)\.webp$/);
    if (match) return `/assets/imgs/testimonial/c${match[1]}.jpeg`;
    if (String(imageUrl || '').startsWith('/assets/')) return imageUrl;
    return `/assets/imgs/testimonial/c${index + 1}.jpeg`;
};

const treatmentRows = treatments.map((item) => {
    const seoTitle = `${item.title_en} Treatment in Raipur | Dr. Trivedi's Homeopathy`;
    const seoDescription = `Homeopathic ${String(item.title_en).toLowerCase()} treatment in Raipur at Dr. Trivedi's Homeopathy Clinic. ${item.description}`.slice(0, 320);
    return `
INSERT INTO \`cms_treatments\`
    (slug, title_en, title_hi, category, description, image_url, seo_title, seo_description, remedies_json, sort_order, is_active)
SELECT
    ${sqlString(item.slug)},
    ${sqlString(item.title_en)},
    ${sqlString(item.title_hi)},
    ${sqlString(item.category)},
    ${sqlString(item.description)},
    ${sqlString(item.image_url)},
    ${sqlString(seoTitle)},
    ${sqlString(seoDescription)},
    ${sqlString(JSON.stringify(item.remedies || []))},
    ${Number(item.sort_order) || 0},
    ${Number(item.is_active) ? 1 : 0}
FROM DUAL
WHERE NOT EXISTS (
    SELECT 1 FROM \`cms_treatments\` WHERE slug = ${sqlString(item.slug)}
);`;
}).join('\n');

const testimonialRows = testimonials.map((item, index) => {
    const assetUrl = testimonialAssetPath(item.image_url, index);
    const webpUrl = `/site-images/images/testimonial-${index + 1}.webp`;
    return `
INSERT INTO \`cms_testimonials\`
    (person_name, person_title, testimonial_text, image_url, tags_json, display_date, sort_order, is_active)
SELECT
    ${sqlString(item.person_name)},
    ${sqlString(item.person_title)},
    ${sqlString(item.testimonial_text)},
    ${sqlString(assetUrl)},
    ${sqlString(JSON.stringify(item.tags || []))},
    ${sqlString(item.display_date)},
    ${Number(item.sort_order) || 0},
    ${Number(item.is_active) ? 1 : 0}
FROM DUAL
WHERE NOT EXISTS (
    SELECT 1 FROM \`cms_testimonials\`
    WHERE image_url IN (${sqlString(assetUrl)}, ${sqlString(webpUrl)})
       OR (person_name = ${sqlString(item.person_name)} AND testimonial_text = ${sqlString(item.testimonial_text)})
);`;
}).join('\n');

const sql = `-- Seeds public CMS catalog for server deploy: cms_treatments + cms_testimonials.
-- Matching migration: sql/migrations/2026-10-25_001_cms_treatments.sql
-- Safe to run more than once. Must run against the API database (DB_NAME in .env).
-- Do not use DELIMITER, SOURCE, or USE.
--
-- Tables:
--   cms_treatments     NEW — create + insert 41 public treatment pages (images under /assets/)
--   cms_testimonials   existing table — insert 11 homepage reviews if missing (images under /assets/imgs/testimonial/)
--   cms_gallery_items  already on server — do not import local gallery rows
--   cms_hero_slides    unused — skip

SET @table_exists = (
  SELECT COUNT(*)
  FROM information_schema.TABLES
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'cms_treatments'
);

SET @create_ddl = IF(
  @table_exists = 0,
  'CREATE TABLE \`cms_treatments\` (
     \`id\` INT UNSIGNED NOT NULL AUTO_INCREMENT,
     \`slug\` VARCHAR(180) NOT NULL,
     \`title_en\` VARCHAR(255) NOT NULL,
     \`title_hi\` VARCHAR(255) NULL,
     \`category\` VARCHAR(64) NOT NULL DEFAULT ''Specialty'',
     \`description\` TEXT NOT NULL,
     \`image_url\` VARCHAR(700) NULL,
     \`image_key\` VARCHAR(700) NULL,
     \`seo_title\` VARCHAR(255) NULL,
     \`seo_description\` VARCHAR(320) NULL,
     \`remedies_json\` TEXT NULL,
     \`sort_order\` INT NOT NULL DEFAULT 0,
     \`is_active\` TINYINT(1) NOT NULL DEFAULT 1,
     \`created_by\` INT NULL,
     \`updated_by\` INT NULL,
     \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
     \`updated_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
     PRIMARY KEY (\`id\`),
     UNIQUE KEY \`uq_cms_treatments_slug\` (\`slug\`),
     KEY \`idx_cms_treatments_active_order\` (\`is_active\`, \`sort_order\`, \`id\`)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci',
  'SELECT 1'
);

PREPARE create_statement FROM @create_ddl;
EXECUTE create_statement;
DEALLOCATE PREPARE create_statement;

${treatmentRows}

${testimonialRows}

SELECT 'cms_treatments' AS cms_table, COUNT(*) AS row_count FROM cms_treatments
UNION ALL
SELECT 'cms_testimonials', COUNT(*) FROM cms_testimonials
UNION ALL
SELECT 'cms_gallery_items', COUNT(*) FROM cms_gallery_items;
`;

fs.writeFileSync(outputPath, sql);
console.log(`Wrote ${treatments.length} treatments and ${testimonials.length} testimonials to ${outputPath}`);
