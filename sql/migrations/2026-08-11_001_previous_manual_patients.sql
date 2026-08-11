-- Previous / manually handled patients (pre-software records)
-- Mobile must be unique within this table; application also checks master_users.

CREATE TABLE IF NOT EXISTS `tbl_previous_manual_patients` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `full_name` VARCHAR(100) NOT NULL,
  `age` TINYINT UNSIGNED NOT NULL,
  `gender` ENUM('male', 'female', 'other') NOT NULL DEFAULT 'other',
  `mobile_no` VARCHAR(15) NOT NULL,
  `email` VARCHAR(255) NULL,
  `address` TEXT NULL,
  `description` TEXT NULL,
  `fk_branch_id` BIGINT UNSIGNED NULL,
  `entered_by_user_id` BIGINT UNSIGNED NOT NULL,
  `entered_by_role` VARCHAR(30) NOT NULL,
  `is_active` TINYINT(1) NOT NULL DEFAULT 1,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `created_by` BIGINT UNSIGNED NULL,
  `updated_by` BIGINT UNSIGNED NULL,
  `created_ip` VARCHAR(45) NOT NULL,
  `updated_ip` VARCHAR(45) NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_previous_manual_patients_mobile` (`mobile_no`),
  KEY `idx_previous_manual_patients_name` (`full_name`),
  KEY `idx_previous_manual_patients_entered_by` (`entered_by_user_id`, `created_at`),
  KEY `idx_previous_manual_patients_branch` (`fk_branch_id`, `created_at`),
  CONSTRAINT `fk_previous_manual_patients_entered_by`
    FOREIGN KEY (`entered_by_user_id`) REFERENCES `master_users` (`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `log_previous_manual_patient_entries` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `previous_patient_id` BIGINT UNSIGNED NOT NULL,
  `action` VARCHAR(20) NOT NULL DEFAULT 'CREATE',
  `entered_by_user_id` BIGINT UNSIGNED NOT NULL,
  `entered_by_role` VARCHAR(30) NOT NULL,
  `ip_address` VARCHAR(45) NULL,
  `user_agent` VARCHAR(500) NULL,
  `payload_json` JSON NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_log_previous_manual_patient` (`previous_patient_id`, `created_at`),
  KEY `idx_log_previous_manual_entered_by` (`entered_by_user_id`, `created_at`),
  CONSTRAINT `fk_log_previous_manual_patient`
    FOREIGN KEY (`previous_patient_id`) REFERENCES `tbl_previous_manual_patients` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_log_previous_manual_entered_by`
    FOREIGN KEY (`entered_by_user_id`) REFERENCES `master_users` (`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
