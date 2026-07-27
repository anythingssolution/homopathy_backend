CREATE TABLE IF NOT EXISTS `tbl_appointment_vitals` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `appointment_id` BIGINT UNSIGNED NOT NULL,
  `oxygen_saturation` VARCHAR(20) NULL DEFAULT NULL,
  `blood_pressure` VARCHAR(20) NULL DEFAULT NULL,
  `patient_height` VARCHAR(20) NULL DEFAULT NULL,
  `patient_weight` VARCHAR(20) NULL DEFAULT NULL,
  `captured_by_role` VARCHAR(20) NULL DEFAULT NULL,
  `captured_by_user_id` BIGINT UNSIGNED NULL DEFAULT NULL,
  `captured_at` DATETIME NULL DEFAULT NULL,
  `updated_by_role` VARCHAR(20) NULL DEFAULT NULL,
  `updated_by_user_id` BIGINT UNSIGNED NULL DEFAULT NULL,
  `updated_at` DATETIME NULL DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_tbl_appointment_vitals_appointment` (`appointment_id`),
  KEY `idx_tbl_appointment_vitals_captured_by` (`captured_by_user_id`),
  KEY `idx_tbl_appointment_vitals_updated_by` (`updated_by_user_id`),
  CONSTRAINT `fk_tbl_appointment_vitals_appointment`
    FOREIGN KEY (`appointment_id`) REFERENCES `tbl_appointments` (`appointment_id`) ON DELETE CASCADE,
  CONSTRAINT `fk_tbl_appointment_vitals_captured_by`
    FOREIGN KEY (`captured_by_user_id`) REFERENCES `master_users` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_tbl_appointment_vitals_updated_by`
    FOREIGN KEY (`updated_by_user_id`) REFERENCES `master_users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
