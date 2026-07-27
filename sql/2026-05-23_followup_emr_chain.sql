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
