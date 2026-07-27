-- CMS Gallery + DigitalOcean Spaces support
-- Run this on homopathy clinic database before gallery import.

CREATE TABLE IF NOT EXISTS cms_gallery_items (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT,
    category VARCHAR(64) NOT NULL DEFAULT 'MEDIA',
    media_type ENUM('IMAGE', 'VIDEO') NOT NULL DEFAULT 'IMAGE',
    title VARCHAR(255) NOT NULL,
    description TEXT NULL,

    image_url VARCHAR(700) NULL,
    image_key VARCHAR(700) NULL,
    image_original_url VARCHAR(700) NULL,
    image_original_key VARCHAR(700) NULL,
    thumb_url VARCHAR(700) NULL,
    thumb_key VARCHAR(700) NULL,

    video_url VARCHAR(700) NULL,
    video_key VARCHAR(700) NULL,
    poster_url VARCHAR(700) NULL,
    poster_key VARCHAR(700) NULL,

    file_mime_type VARCHAR(150) NULL,
    file_size BIGINT UNSIGNED NULL,
    image_width INT NULL,
    image_height INT NULL,
    video_duration_sec DECIMAL(10,2) NULL,

    display_date DATE NULL,
    sort_order INT NOT NULL DEFAULT 0,
    is_active TINYINT(1) NOT NULL DEFAULT 1,

    created_by INT NULL,
    updated_by INT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    PRIMARY KEY (id),
    KEY idx_cms_gallery_active_order (is_active, sort_order, id),
    KEY idx_cms_gallery_category_active_order (category, is_active, sort_order, id),
    KEY idx_cms_gallery_media_type (media_type),
    KEY idx_cms_gallery_display_date (display_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Safe alters for older cms_gallery_items tables.
ALTER TABLE cms_gallery_items
    ADD COLUMN IF NOT EXISTS image_key VARCHAR(700) NULL AFTER image_url,
    ADD COLUMN IF NOT EXISTS image_original_url VARCHAR(700) NULL AFTER image_key,
    ADD COLUMN IF NOT EXISTS image_original_key VARCHAR(700) NULL AFTER image_original_url,
    ADD COLUMN IF NOT EXISTS thumb_url VARCHAR(700) NULL AFTER image_original_key,
    ADD COLUMN IF NOT EXISTS thumb_key VARCHAR(700) NULL AFTER thumb_url,
    ADD COLUMN IF NOT EXISTS video_key VARCHAR(700) NULL AFTER video_url,
    ADD COLUMN IF NOT EXISTS poster_url VARCHAR(700) NULL AFTER video_key,
    ADD COLUMN IF NOT EXISTS poster_key VARCHAR(700) NULL AFTER poster_url,
    ADD COLUMN IF NOT EXISTS file_mime_type VARCHAR(150) NULL AFTER poster_key,
    ADD COLUMN IF NOT EXISTS file_size BIGINT UNSIGNED NULL AFTER file_mime_type,
    ADD COLUMN IF NOT EXISTS image_width INT NULL AFTER file_size,
    ADD COLUMN IF NOT EXISTS image_height INT NULL AFTER image_width,
    ADD COLUMN IF NOT EXISTS video_duration_sec DECIMAL(10,2) NULL AFTER image_height;
