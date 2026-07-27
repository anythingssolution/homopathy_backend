CREATE TABLE IF NOT EXISTS cms_hero_slides (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT,
    title VARCHAR(255) NULL,
    subtitle TEXT NULL,
    cta_text VARCHAR(255) NULL,
    cta_link VARCHAR(500) NULL,
    image_url VARCHAR(500) NOT NULL,
    sort_order INT NOT NULL DEFAULT 0,
    is_active TINYINT(1) NOT NULL DEFAULT 1,
    created_by INT NULL,
    updated_by INT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_cms_hero_active_order (is_active, sort_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS cms_testimonials (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT,
    person_name VARCHAR(255) NOT NULL,
    person_title VARCHAR(255) NULL,
    testimonial_text TEXT NOT NULL,
    image_url VARCHAR(500) NULL,
    tags_json JSON NULL,
    display_date DATE NULL,
    sort_order INT NOT NULL DEFAULT 0,
    is_active TINYINT(1) NOT NULL DEFAULT 1,
    created_by INT NULL,
    updated_by INT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_cms_testimonials_active_order (is_active, sort_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS cms_gallery_items (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT,
    category VARCHAR(64) NOT NULL DEFAULT 'MEDIA',
    media_type ENUM('IMAGE', 'VIDEO') NOT NULL DEFAULT 'IMAGE',
    title VARCHAR(255) NOT NULL,
    description TEXT NULL,
    image_url VARCHAR(500) NULL,
    video_url VARCHAR(500) NULL,
    display_date DATE NULL,
    sort_order INT NOT NULL DEFAULT 0,
    is_active TINYINT(1) NOT NULL DEFAULT 1,
    created_by INT NULL,
    updated_by INT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_cms_gallery_active_order (is_active, sort_order),
    KEY idx_cms_gallery_category (category)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE `tbl_consultations`
  ADD COLUMN `occupation` TEXT NULL AFTER `patient_weight`,
  ADD COLUMN `history_present_illness` TEXT NULL AFTER `occupation`,
  ADD COLUMN `history_past_illness` TEXT NULL AFTER `history_present_illness`,
  ADD COLUMN `family_history` TEXT NULL AFTER `history_past_illness`,
  ADD COLUMN `allergies_history` TEXT NULL AFTER `family_history`,
  ADD COLUMN `gynecological_history` TEXT NULL AFTER `allergies_history`,
  ADD COLUMN `personal_social_history` TEXT NULL AFTER `gynecological_history`,
  ADD COLUMN `general_examination` TEXT NULL AFTER `personal_social_history`,
  ADD COLUMN `systematic_examination` TEXT NULL AFTER `general_examination`,
  ADD COLUMN `differential_diagnosis` TEXT NULL AFTER `systematic_examination`,
  ADD COLUMN `follow_up` TEXT NULL AFTER `differential_diagnosis`,
  ADD COLUMN `disease` VARCHAR(255) NULL AFTER `follow_up`,
  ADD COLUMN `diagnosis` TEXT NULL AFTER `disease`,
  ADD COLUMN `mental_mind_status` TEXT NULL AFTER `diagnosis`;


  ALTER TABLE `tbl_appointments`
  ADD COLUMN `parent_appointment_id` BIGINT UNSIGNED DEFAULT NULL AFTER `fk_patient_family_member_id`,
  ADD KEY `idx_tbl_appointments_parent` (`parent_appointment_id`),
  ADD CONSTRAINT `fk_tbl_appointments_parent`
    FOREIGN KEY (`parent_appointment_id`) REFERENCES `tbl_appointments` (`appointment_id`)
    ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS `tbl_pending_followups` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `parent_appointment_id` BIGINT UNSIGNED NOT NULL,
  `fk_patient_id` BIGINT UNSIGNED NOT NULL,
  `fk_family_member_id` BIGINT UNSIGNED DEFAULT NULL,
  `due_date` DATE NOT NULL,
  `status` ENUM('PENDING', 'NOTIFIED', 'CONFIRMED_BOOKED', 'CANCELLED', 'CLOSED_BY_DOCTOR') NOT NULL DEFAULT 'PENDING',
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_tbl_pending_followups_patient_status_due` (`fk_patient_id`, `status`, `due_date`),
  KEY `idx_tbl_pending_followups_family_status` (`fk_family_member_id`, `status`),
  KEY `idx_tbl_pending_followups_parent_status` (`parent_appointment_id`, `status`),
  CONSTRAINT `fk_tbl_pending_followups_parent`
    FOREIGN KEY (`parent_appointment_id`) REFERENCES `tbl_appointments` (`appointment_id`)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_tbl_pending_followups_patient`
    FOREIGN KEY (`fk_patient_id`) REFERENCES `master_users` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_tbl_pending_followups_family_member`
    FOREIGN KEY (`fk_family_member_id`) REFERENCES `tbl_patient_family_members` (`id`)
    ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;

ALTER TABLE `tbl_consultations`
  ADD COLUMN `follow_up_chain_closed` TINYINT(1) NOT NULL DEFAULT 0 AFTER `medication_duration_days`;

  ALTER TABLE `master_users`
  ADD COLUMN `address` TEXT NULL AFTER `email`;

  ALTER TABLE cms_hero_slides
    ADD COLUMN IF NOT EXISTS image_key VARCHAR(700) NULL AFTER image_url,
    ADD COLUMN IF NOT EXISTS image_original_url VARCHAR(700) NULL AFTER image_key,
    ADD COLUMN IF NOT EXISTS image_original_key VARCHAR(700) NULL AFTER image_original_url,
    ADD COLUMN IF NOT EXISTS image_mime_type VARCHAR(150) NULL AFTER image_original_key,
    ADD COLUMN IF NOT EXISTS image_size BIGINT UNSIGNED NULL AFTER image_mime_type,
    ADD COLUMN IF NOT EXISTS image_width INT NULL AFTER image_size,
    ADD COLUMN IF NOT EXISTS image_height INT NULL AFTER image_width;

ALTER TABLE cms_testimonials
    ADD COLUMN IF NOT EXISTS image_key VARCHAR(700) NULL AFTER image_url,
    ADD COLUMN IF NOT EXISTS image_original_url VARCHAR(700) NULL AFTER image_key,
    ADD COLUMN IF NOT EXISTS image_original_key VARCHAR(700) NULL AFTER image_original_url,
    ADD COLUMN IF NOT EXISTS image_mime_type VARCHAR(150) NULL AFTER image_original_key,
    ADD COLUMN IF NOT EXISTS image_size BIGINT UNSIGNED NULL AFTER image_mime_type,
    ADD COLUMN IF NOT EXISTS image_width INT NULL AFTER image_size,
    ADD COLUMN IF NOT EXISTS image_height INT NULL AFTER image_width;

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