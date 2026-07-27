CREATE TABLE IF NOT EXISTS `tbl_doctor_slot_time_overrides` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `fk_branch_id` BIGINT UNSIGNED NOT NULL,
  `fk_slot_id` BIGINT UNSIGNED NOT NULL,
  `appointment_date` DATE NOT NULL,
  `default_start_time` TIME NOT NULL,
  `default_end_time` TIME NOT NULL,
  `override_start_time` TIME NOT NULL,
  `override_end_time` TIME NOT NULL,
  `shift_seconds` INT NOT NULL,
  `reason` VARCHAR(500) NULL,
  `status` ENUM('ACTIVE', 'CANCELLED') NOT NULL DEFAULT 'ACTIVE',
  `created_by` BIGINT UNSIGNED NOT NULL,
  `updated_by` BIGINT UNSIGNED NOT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `cancelled_by` BIGINT UNSIGNED NULL,
  `cancelled_at` TIMESTAMP NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_doctor_slot_time_override`
    (`fk_branch_id`, `fk_slot_id`, `appointment_date`),
  KEY `idx_doctor_slot_time_override_lookup`
    (`appointment_date`, `fk_branch_id`, `fk_slot_id`, `status`),
  CONSTRAINT `fk_doctor_slot_override_branch`
    FOREIGN KEY (`fk_branch_id`) REFERENCES `master_clinic_branches` (`id`),
  CONSTRAINT `fk_doctor_slot_override_slot`
    FOREIGN KEY (`fk_slot_id`) REFERENCES `master_slots` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `tbl_doctor_slot_time_override_audit_logs` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `fk_override_id` BIGINT UNSIGNED NULL,
  `fk_branch_id` BIGINT UNSIGNED NOT NULL,
  `fk_slot_id` BIGINT UNSIGNED NOT NULL,
  `appointment_date` DATE NOT NULL,
  `action` VARCHAR(40) NOT NULL,
  `old_data_json` JSON NULL,
  `new_data_json` JSON NULL,
  `affected_appointments` INT UNSIGNED NOT NULL DEFAULT 0,
  `affected_extension_tokens` INT UNSIGNED NOT NULL DEFAULT 0,
  `performed_by` BIGINT UNSIGNED NOT NULL,
  `performed_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `ip_address` VARCHAR(45) NULL,
  PRIMARY KEY (`id`),
  KEY `idx_doctor_slot_override_audit`
    (`fk_branch_id`, `fk_slot_id`, `appointment_date`, `performed_at`),
  CONSTRAINT `fk_doctor_slot_override_audit_header`
    FOREIGN KEY (`fk_override_id`) REFERENCES `tbl_doctor_slot_time_overrides` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
