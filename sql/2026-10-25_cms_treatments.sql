-- Adds cms_treatments so doctors can publish new public treatment pages with SEO slugs.
-- Matching migration: sql/migrations/2026-10-25_001_cms_treatments.sql
-- Safe to re-run. Must run against the API database (DB_NAME in .env).
-- Do not use DELIMITER, SOURCE, or USE.

SET @table_exists = (
  SELECT COUNT(*)
  FROM information_schema.TABLES
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'cms_treatments'
);

SET @create_ddl = IF(
  @table_exists = 0,
  'CREATE TABLE `cms_treatments` (
     `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
     `slug` VARCHAR(180) NOT NULL,
     `title_en` VARCHAR(255) NOT NULL,
     `title_hi` VARCHAR(255) NULL,
     `category` VARCHAR(64) NOT NULL DEFAULT ''Specialty'',
     `description` TEXT NOT NULL,
     `image_url` VARCHAR(700) NULL,
     `image_key` VARCHAR(700) NULL,
     `seo_title` VARCHAR(255) NULL,
     `seo_description` VARCHAR(320) NULL,
     `remedies_json` TEXT NULL,
     `sort_order` INT NOT NULL DEFAULT 0,
     `is_active` TINYINT(1) NOT NULL DEFAULT 1,
     `created_by` INT NULL,
     `updated_by` INT NULL,
     `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
     `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
     PRIMARY KEY (`id`),
     UNIQUE KEY `uq_cms_treatments_slug` (`slug`),
     KEY `idx_cms_treatments_active_order` (`is_active`, `sort_order`, `id`)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci',
  'SELECT 1'
);

PREPARE create_statement FROM @create_ddl;
EXECUTE create_statement;
DEALLOCATE PREPARE create_statement;

SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME = 'cms_treatments'
ORDER BY ORDINAL_POSITION;
