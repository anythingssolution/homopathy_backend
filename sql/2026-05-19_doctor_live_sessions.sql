CREATE TABLE IF NOT EXISTS `tbl_doctor_live_sessions` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `doctor_id` BIGINT UNSIGNED NOT NULL,
  `fk_branch_id` BIGINT UNSIGNED NULL,
  `session_status` ENUM('IN', 'OUT') NOT NULL DEFAULT 'IN',
  `started_at` DATETIME NOT NULL,
  `ended_at` DATETIME NULL DEFAULT NULL,
  `note` VARCHAR(255) NULL DEFAULT NULL,
  `source` ENUM('MANUAL', 'AUTO') NOT NULL DEFAULT 'MANUAL',
  `started_by_user_id` BIGINT UNSIGNED NULL,
  `started_by_role` VARCHAR(20) NULL DEFAULT NULL,
  `ended_by_user_id` BIGINT UNSIGNED NULL,
  `ended_by_role` VARCHAR(20) NULL DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_doctor_live_sessions_doctor` (`doctor_id`),
  KEY `idx_doctor_live_sessions_branch` (`fk_branch_id`),
  KEY `idx_doctor_live_sessions_status` (`session_status`),
  KEY `idx_doctor_live_sessions_started_at` (`started_at`),
  CONSTRAINT `fk_doctor_live_sessions_doctor`
    FOREIGN KEY (`doctor_id`) REFERENCES `master_users` (`id`),
  CONSTRAINT `fk_doctor_live_sessions_branch`
    FOREIGN KEY (`fk_branch_id`) REFERENCES `master_clinic_branches` (`id`),
  CONSTRAINT `fk_doctor_live_sessions_started_by`
    FOREIGN KEY (`started_by_user_id`) REFERENCES `master_users` (`id`),
  CONSTRAINT `fk_doctor_live_sessions_ended_by`
    FOREIGN KEY (`ended_by_user_id`) REFERENCES `master_users` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `tbl_doctor_live_session_logs` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `doctor_session_id` BIGINT UNSIGNED NULL,
  `doctor_id` BIGINT UNSIGNED NOT NULL,
  `fk_branch_id` BIGINT UNSIGNED NULL,
  `old_status` ENUM('IN', 'OUT') NULL DEFAULT NULL,
  `new_status` ENUM('IN', 'OUT') NOT NULL,
  `action` ENUM('START_SESSION', 'PAUSE_SESSION', 'AUTO_TIMEOUT', 'FORCE_END') NOT NULL,
  `note` VARCHAR(255) NULL DEFAULT NULL,
  `changed_by_user_id` BIGINT UNSIGNED NULL,
  `changed_by_role` VARCHAR(20) NULL DEFAULT NULL,
  `source` ENUM('MANUAL', 'AUTO') NOT NULL DEFAULT 'MANUAL',
  `ip_address` VARCHAR(64) NULL DEFAULT NULL,
  `user_agent` VARCHAR(255) NULL DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_doctor_live_session_logs_session` (`doctor_session_id`),
  KEY `idx_doctor_live_session_logs_doctor` (`doctor_id`),
  KEY `idx_doctor_live_session_logs_branch` (`fk_branch_id`),
  KEY `idx_doctor_live_session_logs_created_at` (`created_at`),
  CONSTRAINT `fk_doctor_live_session_logs_session`
    FOREIGN KEY (`doctor_session_id`) REFERENCES `tbl_doctor_live_sessions` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_doctor_live_session_logs_doctor`
    FOREIGN KEY (`doctor_id`) REFERENCES `master_users` (`id`),
  CONSTRAINT `fk_doctor_live_session_logs_branch`
    FOREIGN KEY (`fk_branch_id`) REFERENCES `master_clinic_branches` (`id`),
  CONSTRAINT `fk_doctor_live_session_logs_changed_by`
    FOREIGN KEY (`changed_by_user_id`) REFERENCES `master_users` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
