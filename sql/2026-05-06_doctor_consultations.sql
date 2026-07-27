CREATE TABLE IF NOT EXISTS `tbl_consultations` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `appointment_id` BIGINT UNSIGNED NOT NULL,
  `doctor_id` BIGINT UNSIGNED NOT NULL,
  `symptoms` TEXT NOT NULL,
  `treatment_advice` TEXT NOT NULL,
  `medication_duration_days` TINYINT UNSIGNED NOT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_consultation_appointment` (`appointment_id`),
  KEY `idx_consultations_doctor` (`doctor_id`),
  CONSTRAINT `fk_consultation_appointment`
    FOREIGN KEY (`appointment_id`) REFERENCES `tbl_appointments` (`appointment_id`)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_consultation_doctor`
    FOREIGN KEY (`doctor_id`) REFERENCES `master_users` (`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `chk_consultation_duration`
    CHECK (`medication_duration_days` IN (7, 15, 30))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;

CREATE TABLE IF NOT EXISTS `tbl_consultation_medications` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `consultation_id` BIGINT UNSIGNED NOT NULL,
  `medicine_type` ENUM('NUMERIC', 'TEXT') NOT NULL,
  `medicine_value` VARCHAR(255) NOT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_consultation_medications_consultation` (`consultation_id`),
  CONSTRAINT `fk_consultation_medications_consultation`
    FOREIGN KEY (`consultation_id`) REFERENCES `tbl_consultations` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;

CREATE TABLE IF NOT EXISTS `tbl_medication_dosages` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `consultation_medication_id` BIGINT UNSIGNED NOT NULL,
  `times_per_day` TINYINT UNSIGNED NOT NULL,
  `balls_per_dose` TINYINT UNSIGNED NOT NULL,
  `instructions` VARCHAR(255) DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_medication_dosage_consultation_medication` (`consultation_medication_id`),
  CONSTRAINT `fk_medication_dosages_consultation_medication`
    FOREIGN KEY (`consultation_medication_id`) REFERENCES `tbl_consultation_medications` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;
