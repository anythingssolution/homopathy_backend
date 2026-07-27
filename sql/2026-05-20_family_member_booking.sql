CREATE TABLE `tbl_patient_family_members` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `fk_primary_patient_id` BIGINT UNSIGNED NOT NULL,
  `full_name` VARCHAR(100) NOT NULL,
  `age` TINYINT UNSIGNED NOT NULL,
  `gender` ENUM('male','female','other') NOT NULL DEFAULT 'other',
  `relationship` VARCHAR(50) NOT NULL,
  `description` TEXT DEFAULT NULL,
  `is_active` TINYINT(1) NOT NULL DEFAULT 1,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `created_by` BIGINT UNSIGNED DEFAULT NULL,
  `updated_by` BIGINT UNSIGNED DEFAULT NULL,
  `created_ip` VARCHAR(45) NOT NULL,
  `updated_ip` VARCHAR(45) DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_family_members_primary_patient` (`fk_primary_patient_id`,`is_active`,`created_at`),
  CONSTRAINT `fk_family_members_primary_patient`
    FOREIGN KEY (`fk_primary_patient_id`) REFERENCES `master_users` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

ALTER TABLE `tbl_appointments`
  ADD COLUMN `fk_patient_family_member_id` BIGINT UNSIGNED NULL AFTER `fk_patient_id`,
  ADD COLUMN `booked_for_type` ENUM('SELF','FAMILY_MEMBER') NOT NULL DEFAULT 'SELF' AFTER `booked_by_type`,
  ADD COLUMN `booking_subject_key` VARCHAR(64) NOT NULL DEFAULT '' AFTER `booked_for_type`,
  ADD KEY `idx_tbl_appointments_family_member` (`fk_patient_family_member_id`),
  ADD KEY `idx_tbl_appointments_patient_date_active` (`fk_patient_id`,`appointment_date`,`is_active`),
  ADD CONSTRAINT `fk_tbl_appointments_family_member`
    FOREIGN KEY (`fk_patient_family_member_id`) REFERENCES `tbl_patient_family_members` (`id`)
    ON DELETE SET NULL ON UPDATE CASCADE;

UPDATE `tbl_appointments`
SET `booking_subject_key` = CASE
  WHEN `booked_for_type` = 'FAMILY_MEMBER' AND `fk_patient_family_member_id` IS NOT NULL
    THEN CONCAT('FM:', `fk_patient_family_member_id`)
  ELSE CONCAT('SELF:', `fk_patient_id`)
END
WHERE `booking_subject_key` = '' OR `booking_subject_key` IS NULL;

ALTER TABLE `tbl_appointments`
  DROP INDEX `uq_appointment_patient_branch_slot_date_active`,
  ADD UNIQUE KEY `uq_appointment_booking_subject_date_active` (`booking_subject_key`,`appointment_date`,`is_active`);
