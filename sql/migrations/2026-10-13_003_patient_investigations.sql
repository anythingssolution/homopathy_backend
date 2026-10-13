CREATE TABLE IF NOT EXISTS `tbl_patient_investigations` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `appointment_id` BIGINT UNSIGNED NOT NULL,
  `consultation_id` BIGINT UNSIGNED NULL,
  `patient_id` BIGINT UNSIGNED NOT NULL,
  `family_member_id` BIGINT UNSIGNED NULL,
  `fk_branch_id` BIGINT UNSIGNED NOT NULL,
  `doctor_id` BIGINT UNSIGNED NULL,
  `investigation_type` VARCHAR(40) NOT NULL,
  `test_name` VARCHAR(255) NULL,
  `investigation_date` DATE NULL,
  `status` VARCHAR(40) NOT NULL DEFAULT 'DONE',
  `findings` TEXT NULL,
  `report_reference` VARCHAR(255) NULL,
  `document_id` BIGINT UNSIGNED NULL,
  `created_by_role` VARCHAR(20) NULL,
  `created_by_user_id` BIGINT UNSIGNED NULL,
  `updated_by_role` VARCHAR(20) NULL,
  `updated_by_user_id` BIGINT UNSIGNED NULL,
  `is_active` TINYINT(1) NOT NULL DEFAULT 1,
  `created_at` TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_patient_investigations_appointment` (`appointment_id`, `is_active`),
  KEY `idx_patient_investigations_consultation` (`consultation_id`, `is_active`),
  KEY `idx_patient_investigations_patient` (`patient_id`, `family_member_id`, `investigation_date`),
  KEY `idx_patient_investigations_type_status` (`investigation_type`, `status`),
  KEY `idx_patient_investigations_document` (`document_id`),
  CONSTRAINT `fk_patient_investigations_appointment`
    FOREIGN KEY (`appointment_id`) REFERENCES `tbl_appointments` (`appointment_id`)
    ON DELETE CASCADE,
  CONSTRAINT `fk_patient_investigations_consultation`
    FOREIGN KEY (`consultation_id`) REFERENCES `tbl_consultations` (`id`)
    ON DELETE SET NULL,
  CONSTRAINT `fk_patient_investigations_patient`
    FOREIGN KEY (`patient_id`) REFERENCES `master_users` (`id`)
    ON DELETE CASCADE,
  CONSTRAINT `fk_patient_investigations_family_member`
    FOREIGN KEY (`family_member_id`) REFERENCES `tbl_patient_family_members` (`id`)
    ON DELETE SET NULL,
  CONSTRAINT `fk_patient_investigations_branch`
    FOREIGN KEY (`fk_branch_id`) REFERENCES `master_clinic_branches` (`id`)
    ON DELETE RESTRICT,
  CONSTRAINT `fk_patient_investigations_doctor`
    FOREIGN KEY (`doctor_id`) REFERENCES `master_users` (`id`)
    ON DELETE SET NULL,
  CONSTRAINT `fk_patient_investigations_document`
    FOREIGN KEY (`document_id`) REFERENCES `tbl_patient_clinical_documents` (`id`)
    ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
