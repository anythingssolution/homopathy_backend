CREATE TABLE IF NOT EXISTS `doctor_numeric_formula_sets` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `doctor_id` BIGINT UNSIGNED NOT NULL,
  `set_name` VARCHAR(150) NOT NULL,
  `description` VARCHAR(255) NULL DEFAULT NULL,
  `is_default` TINYINT(1) NOT NULL DEFAULT 0,
  `is_active` TINYINT(1) NOT NULL DEFAULT 0,
  `is_published` TINYINT(1) NOT NULL DEFAULT 1,
  `version_no` INT NOT NULL DEFAULT 1,
  `published_at` TIMESTAMP NULL DEFAULT NULL,
  `created_by` BIGINT UNSIGNED NULL DEFAULT NULL,
  `updated_by` BIGINT UNSIGNED NULL DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_formula_sets_doctor_active` (`doctor_id`, `is_active`),
  CONSTRAINT `fk_formula_sets_doctor`
    FOREIGN KEY (`doctor_id`) REFERENCES `master_users` (`id`)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `doctor_numeric_formula_templates` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `formula_set_id` BIGINT UNSIGNED NOT NULL,
  `template_code` VARCHAR(50) NOT NULL,
  `template_name` VARCHAR(100) NOT NULL,
  `is_default` TINYINT(1) NOT NULL DEFAULT 0,
  `is_active` TINYINT(1) NOT NULL DEFAULT 1,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_formula_template_code_per_set` (`formula_set_id`, `template_code`),
  CONSTRAINT `fk_formula_templates_set`
    FOREIGN KEY (`formula_set_id`) REFERENCES `doctor_numeric_formula_sets` (`id`)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `doctor_numeric_formula_template_rows` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `template_id` BIGINT UNSIGNED NOT NULL,
  `dose_label` VARCHAR(50) NOT NULL,
  `sort_order` INT NOT NULL DEFAULT 1,
  `times_per_day` INT NOT NULL DEFAULT 1,
  `balls_per_dose` INT NOT NULL,
  `instructions` VARCHAR(255) NULL DEFAULT NULL,
  `is_active` TINYINT(1) NOT NULL DEFAULT 1,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_formula_template_rows_template` (`template_id`, `sort_order`),
  CONSTRAINT `fk_formula_template_rows_template`
    FOREIGN KEY (`template_id`) REFERENCES `doctor_numeric_formula_templates` (`id`)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `doctor_numeric_formula_rules` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `formula_set_id` BIGINT UNSIGNED NOT NULL,
  `rule_key` ENUM('PLAIN_NUMBER', 'SLASH_SINGLE_NUMERIC', 'SLASH_DOUBLE_NUMERIC') NOT NULL,
  `amount_strategy` ENUM('FIXED', 'MULTIPLY_SUFFIX') NOT NULL,
  `fixed_amount` DECIMAL(10,2) NULL DEFAULT NULL,
  `multiplier_value` DECIMAL(10,2) NULL DEFAULT NULL,
  `template_id` BIGINT UNSIGNED NULL DEFAULT NULL,
  `is_active` TINYINT(1) NOT NULL DEFAULT 1,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_formula_rules_set_key` (`formula_set_id`, `rule_key`),
  KEY `idx_formula_rules_template` (`template_id`),
  CONSTRAINT `fk_formula_rules_set`
    FOREIGN KEY (`formula_set_id`) REFERENCES `doctor_numeric_formula_sets` (`id`)
    ON DELETE CASCADE,
  CONSTRAINT `fk_formula_rules_template`
    FOREIGN KEY (`template_id`) REFERENCES `doctor_numeric_formula_templates` (`id`)
    ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `doctor_numeric_formula_alpha_codes` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `formula_set_id` BIGINT UNSIGNED NOT NULL,
  `code` VARCHAR(50) NOT NULL,
  `description` VARCHAR(255) NULL DEFAULT NULL,
  `fixed_amount` DECIMAL(10,2) NULL DEFAULT NULL,
  `template_id` BIGINT UNSIGNED NULL DEFAULT NULL,
  `duration_override_days` INT NULL DEFAULT NULL,
  `is_active` TINYINT(1) NOT NULL DEFAULT 1,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_formula_alpha_code_set` (`formula_set_id`, `code`),
  KEY `idx_formula_alpha_template` (`template_id`),
  CONSTRAINT `fk_formula_alpha_set`
    FOREIGN KEY (`formula_set_id`) REFERENCES `doctor_numeric_formula_sets` (`id`)
    ON DELETE CASCADE,
  CONSTRAINT `fk_formula_alpha_template`
    FOREIGN KEY (`template_id`) REFERENCES `doctor_numeric_formula_templates` (`id`)
    ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `doctor_numeric_formula_audit_logs` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `doctor_id` BIGINT UNSIGNED NOT NULL,
  `formula_set_id` BIGINT UNSIGNED NULL DEFAULT NULL,
  `action_type` VARCHAR(30) NOT NULL,
  `entity_type` VARCHAR(50) NOT NULL,
  `entity_id` BIGINT UNSIGNED NULL DEFAULT NULL,
  `before_json` JSON NULL,
  `after_json` JSON NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_formula_audit_doctor_created` (`doctor_id`, `created_at`),
  CONSTRAINT `fk_formula_audit_doctor`
    FOREIGN KEY (`doctor_id`) REFERENCES `master_users` (`id`)
    ON DELETE CASCADE,
  CONSTRAINT `fk_formula_audit_set`
    FOREIGN KEY (`formula_set_id`) REFERENCES `doctor_numeric_formula_sets` (`id`)
    ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE `tbl_consultations`
  ADD COLUMN IF NOT EXISTS `formula_set_id` BIGINT UNSIGNED NULL AFTER `mental_mind_status`,
  ADD COLUMN IF NOT EXISTS `formula_version_used` INT NULL AFTER `formula_set_id`,
  ADD COLUMN IF NOT EXISTS `quick_formula_input` TEXT NULL AFTER `formula_version_used`,
  ADD KEY `idx_tbl_consultations_formula_set` (`formula_set_id`),
  ADD CONSTRAINT `fk_tbl_consultations_formula_set`
    FOREIGN KEY (`formula_set_id`) REFERENCES `doctor_numeric_formula_sets` (`id`)
    ON DELETE SET NULL;
