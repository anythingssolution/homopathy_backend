-- Fix previous-patient tables: InnoDB + create entry log table.
-- Safe to re-run.

ALTER TABLE `tbl_previous_manual_patients` ENGINE=InnoDB;

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
