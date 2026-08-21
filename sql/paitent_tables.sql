-- 1. Master User Table (For Registration & Login)
CREATE TABLE IF NOT EXISTS `master_users` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `uuid` CHAR(36) NOT NULL,
  `clinic_patient_no` VARCHAR(50) NULL,
  `full_name` VARCHAR(100) NOT NULL,
  `age` TINYINT UNSIGNED NOT NULL DEFAULT 18,
  `gender` ENUM('male', 'female', 'other') NOT NULL DEFAULT 'other',
  `email` VARCHAR(255) NULL,
  `address` TEXT NULL,
  `area_name` VARCHAR(150) NULL,
  `ward_no` VARCHAR(50) NULL,
  `vidhan_sabha` VARCHAR(150) NULL,
  `pincode` VARCHAR(10) NULL,
  `city` VARCHAR(100) NULL,
  `description` TEXT NULL,
  `mobile_no` VARCHAR(15) NOT NULL,
  `password` VARCHAR(255) NOT NULL, -- Hashed password
  `role` VARCHAR(20) NOT NULL DEFAULT 'PAT',
  `is_active` TINYINT(1) DEFAULT 1,
  -- 6 Audit Columns
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `created_by` BIGINT UNSIGNED NULL, -- Admin ya Self-registered ID
  `updated_by` BIGINT UNSIGNED NULL,
  `created_ip` VARCHAR(45) NOT NULL,
  `updated_ip` VARCHAR(45) NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `idx_patient_uuid` (`uuid`),
  INDEX `idx_master_users_clinic_patient_no` (`clinic_patient_no`),
  INDEX `idx_master_users_area_name` (`area_name`),
  INDEX `idx_master_users_pincode` (`pincode`),
  INDEX `idx_master_users_city` (`city`),
  UNIQUE INDEX `idx_patient_mobile` (`mobile_no`),
  UNIQUE INDEX `idx_patient_email` (`email`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 1.0 Family Members / Dependents for a primary patient account
CREATE TABLE IF NOT EXISTS `tbl_patient_family_members` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `fk_primary_patient_id` BIGINT UNSIGNED NOT NULL,
  `full_name` VARCHAR(100) NOT NULL,
  `age` TINYINT UNSIGNED NOT NULL,
  `gender` ENUM('male', 'female', 'other') NOT NULL DEFAULT 'other',
  `relationship` VARCHAR(50) NOT NULL,
  `description` TEXT NULL,
  `is_active` TINYINT(1) NOT NULL DEFAULT 1,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `created_by` BIGINT UNSIGNED NULL,
  `updated_by` BIGINT UNSIGNED NULL,
  `created_ip` VARCHAR(45) NOT NULL,
  `updated_ip` VARCHAR(45) NULL,
  PRIMARY KEY (`id`),
  INDEX `idx_family_members_primary_patient` (`fk_primary_patient_id`, `is_active`, `created_at`),
  CONSTRAINT `fk_family_members_primary_patient`
    FOREIGN KEY (`fk_primary_patient_id`) REFERENCES `master_users` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- 1.1 Master Languages (for preference during login)
CREATE TABLE IF NOT EXISTS `master_languages` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `code` VARCHAR(12) NOT NULL,
  `name` VARCHAR(100) NOT NULL,
  `is_active` TINYINT(1) DEFAULT 1,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `idx_language_code` (`code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT INTO `master_languages` (`code`, `name`)
VALUES
  ('en', 'English'),
  ('hi', 'Hindi')
ON DUPLICATE KEY UPDATE `name` = VALUES(`name`);

-- 1.2 Transaction OTP Table (login and registration purposes)
CREATE TABLE IF NOT EXISTS `tbl_user_otps` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `patient_id` BIGINT UNSIGNED NULL,
  `purpose` ENUM('register','login','forgot_password') NOT NULL,
  `mobile_no` VARCHAR(15) NOT NULL,
  `otp_hash` VARCHAR(255) NOT NULL,
  `expires_at` TIMESTAMP NOT NULL,
  `resend_available_at` TIMESTAMP NOT NULL,
  `attempt_count` TINYINT UNSIGNED NOT NULL DEFAULT 0,
  `is_used` TINYINT(1) NOT NULL DEFAULT 0,
  `verified_at` TIMESTAMP NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  INDEX `idx_tbl_user_otps_mobile` (`mobile_no`),
  INDEX `idx_tbl_user_otps_user` (`patient_id`),
  INDEX `idx_tbl_user_otps_purpose` (`purpose`),
  CONSTRAINT `fk_tbl_user_otps_user`
    FOREIGN KEY (`patient_id`) REFERENCES `master_users` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 1.3 Login Audit Table (language preference capture)
CREATE TABLE IF NOT EXISTS `log_user_logins` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `patient_id` BIGINT UNSIGNED NOT NULL,
  `language_id` BIGINT UNSIGNED NOT NULL,
  `login_method` ENUM('password', 'otp') NOT NULL,
  `login_ip` VARCHAR(45) NULL,
  `user_agent` VARCHAR(255) NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  INDEX `idx_log_user_logins_user` (`patient_id`),
  INDEX `idx_log_user_logins_language` (`language_id`),
  CONSTRAINT `fk_log_user_logins_user`
    FOREIGN KEY (`patient_id`) REFERENCES `master_users` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_log_user_logins_language`
    FOREIGN KEY (`language_id`) REFERENCES `master_languages` (`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `log_user_profile_updates` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id` BIGINT UNSIGNED NOT NULL,
  `changed_by_user_id` BIGINT UNSIGNED NULL,
  `changed_by_role` VARCHAR(20) NULL,
  `ip_address` VARCHAR(64) NULL,
  `user_agent` VARCHAR(255) NULL,
  `changed_fields_json` JSON NOT NULL,
  `old_values_json` JSON NOT NULL,
  `new_values_json` JSON NOT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  INDEX `idx_log_user_profile_updates_user` (`user_id`),
  INDEX `idx_log_user_profile_updates_actor` (`changed_by_user_id`),
  INDEX `idx_log_user_profile_updates_created_at` (`created_at`),
  CONSTRAINT `fk_log_user_profile_updates_user`
    FOREIGN KEY (`user_id`) REFERENCES `master_users` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_log_user_profile_updates_actor`
    FOREIGN KEY (`changed_by_user_id`) REFERENCES `master_users` (`id`)
    ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 1.4 Refresh token store (rotation + revocation)
CREATE TABLE IF NOT EXISTS `tbl_user_refresh_tokens` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `patient_id` BIGINT UNSIGNED NOT NULL,
  `token_jti` VARCHAR(64) NOT NULL,
  `token_hash` CHAR(64) NOT NULL,
  `expires_at` TIMESTAMP NOT NULL,
  `revoked_at` TIMESTAMP NULL,
  `created_ip` VARCHAR(45) NULL,
  `user_agent` VARCHAR(255) NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `uq_user_refresh_jti` (`token_jti`),
  UNIQUE INDEX `uq_user_refresh_hash` (`token_hash`),
  INDEX `idx_user_refresh_user` (`patient_id`),
  INDEX `idx_user_refresh_expires` (`expires_at`),
  CONSTRAINT `fk_user_refresh_user`
    FOREIGN KEY (`patient_id`) REFERENCES `master_users` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 1.5 Access token blacklist (logout of active access token)
CREATE TABLE IF NOT EXISTS `tbl_user_access_token_blacklist` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `patient_id` BIGINT UNSIGNED NOT NULL,
  `token_jti` VARCHAR(64) NOT NULL,
  `expires_at` TIMESTAMP NOT NULL,
  `revoked_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `uq_user_access_blacklist_jti` (`token_jti`),
  INDEX `idx_user_access_blacklist_user` (`patient_id`),
  INDEX `idx_user_access_blacklist_expires` (`expires_at`),
  CONSTRAINT `fk_user_access_blacklist_user`
    FOREIGN KEY (`patient_id`) REFERENCES `master_users` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 2. Appointments Table (Booking Logic)
CREATE TABLE `tbl_appointments` (
  `appointment_id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `auid` varchar(24) NOT NULL,
  `fk_patient_id` bigint(20) unsigned NOT NULL,
  `fk_patient_family_member_id` bigint(20) unsigned DEFAULT NULL,
  `fk_branch_id` bigint(20) unsigned NOT NULL,
  `fk_treatment_id` bigint(20) unsigned NOT NULL,
  `fk_slot_id` bigint(20) unsigned NOT NULL,
  `token_number` tinyint(3) unsigned DEFAULT NULL COMMENT 'Range: 1-40',
  `booked_for_type` enum('SELF','FAMILY_MEMBER') NOT NULL DEFAULT 'SELF',
  `booking_subject_key` varchar(64) NOT NULL DEFAULT '',
  `appointment_date` date NOT NULL,
  `symptoms` text DEFAULT NULL,
  `status` enum('Pending','Confirmed','Completed','Cancelled') DEFAULT 'Pending',
  `queue_status` enum('BOOKED','CHECKED_IN','WAITING','IN_PROGRESS','COMPLETED','CANCELLED','NO_SHOW','SKIPPED') NOT NULL DEFAULT 'BOOKED',
  `planned_start_at` datetime DEFAULT NULL,
  `planned_end_at` datetime DEFAULT NULL,
  `actual_called_at` datetime DEFAULT NULL,
  `actual_started_at` datetime DEFAULT NULL,
  `actual_completed_at` datetime DEFAULT NULL,
  `last_queue_event_at` datetime DEFAULT NULL,
  `cancelled_at` timestamp NULL DEFAULT NULL,
  `cancelled_by_user_id` bigint(20) unsigned DEFAULT NULL,
  `cancelled_by_role` varchar(20) DEFAULT NULL,
  `cancel_reason` varchar(255) DEFAULT NULL,
  `is_active` tinyint(1) DEFAULT 1,
  `active_token_booking_key` varchar(120) GENERATED ALWAYS AS (
    CASE
      WHEN `is_active` = 1
        AND `status` <> 'Cancelled'
        AND coalesce(`reception_status`,'') <> 'REJECTED_BY_RECEPTION'
        AND coalesce(`queue_status`,'') <> 'CANCELLED'
      THEN concat(`fk_branch_id`,':',`fk_slot_id`,':',`appointment_date`,':',`token_number`)
      ELSE NULL
    END
  ) STORED,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  `created_by` bigint(20) unsigned DEFAULT NULL,
  `updated_by` bigint(20) unsigned DEFAULT NULL,
  `created_ip` varchar(45) NOT NULL,
  `updated_ip` varchar(45) DEFAULT NULL,
  PRIMARY KEY (`appointment_id`),
  UNIQUE KEY `uq_appointment_auid` (`auid`),
  KEY `con_fk_apt_patient` (`fk_patient_id`),
  KEY `con_fk_apt_branch` (`fk_branch_id`),
  KEY `con_fk_apt_treatment` (`fk_treatment_id`),
  KEY `con_fk_apt_slot` (`fk_slot_id`),
  KEY `idx_tbl_appointments_family_member` (`fk_patient_family_member_id`),
  KEY `con_fk_apt_cancelled_by` (`cancelled_by_user_id`),
  KEY `idx_tbl_appointments_live_queue` (`fk_branch_id`,`fk_slot_id`,`appointment_date`,`queue_status`,`is_active`,`token_number`),
  KEY `idx_tbl_appointments_patient_date_active` (`fk_patient_id`,`appointment_date`,`is_active`),
  KEY `idx_appointment_booking_subject_date_active` (`booking_subject_key`,`appointment_date`,`is_active`),
  UNIQUE KEY `uq_appointment_active_token_booking` (`active_token_booking_key`),
  CONSTRAINT `con_fk_apt_branch` FOREIGN KEY (`fk_branch_id`) REFERENCES `master_clinic_branches` (`id`),
  CONSTRAINT `con_fk_apt_cancelled_by` FOREIGN KEY (`cancelled_by_user_id`) REFERENCES `master_users` (`id`),
  CONSTRAINT `fk_tbl_appointments_family_member` FOREIGN KEY (`fk_patient_family_member_id`) REFERENCES `tbl_patient_family_members` (`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `con_fk_apt_patient` FOREIGN KEY (`fk_patient_id`) REFERENCES `master_users` (`id`),
  CONSTRAINT `con_fk_apt_slot` FOREIGN KEY (`fk_slot_id`) REFERENCES `master_slots` (`id`),
  CONSTRAINT `con_fk_apt_treatment` FOREIGN KEY (`fk_treatment_id`) REFERENCES `master_treatments` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;

CREATE TABLE `tbl_live_queue_sessions` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `fk_branch_id` bigint(20) unsigned NOT NULL,
  `fk_slot_id` bigint(20) unsigned NOT NULL,
  `appointment_date` date NOT NULL,
  `session_status` enum('NOT_STARTED','RUNNING','COMPLETED','PAUSED') NOT NULL DEFAULT 'NOT_STARTED',
  `current_appointment_id` bigint(20) unsigned DEFAULT NULL,
  `current_token_number` tinyint(3) unsigned DEFAULT NULL,
  `session_started_at` datetime DEFAULT NULL,
  `session_ended_at` datetime DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  `created_by` bigint(20) unsigned DEFAULT NULL,
  `updated_by` bigint(20) unsigned DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_live_queue_session_slot_date` (`fk_branch_id`,`fk_slot_id`,`appointment_date`),
  KEY `idx_live_queue_session_current_appointment` (`current_appointment_id`),
  CONSTRAINT `fk_live_queue_session_branch` FOREIGN KEY (`fk_branch_id`) REFERENCES `master_clinic_branches` (`id`),
  CONSTRAINT `fk_live_queue_session_slot` FOREIGN KEY (`fk_slot_id`) REFERENCES `master_slots` (`id`),
  CONSTRAINT `fk_live_queue_session_current_appointment` FOREIGN KEY (`current_appointment_id`) REFERENCES `tbl_appointments` (`appointment_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;

CREATE TABLE `tbl_appointment_queue_events` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `appointment_id` bigint(20) unsigned DEFAULT NULL,
  `fk_branch_id` bigint(20) unsigned NOT NULL,
  `fk_slot_id` bigint(20) unsigned NOT NULL,
  `appointment_date` date NOT NULL,
  `token_number` tinyint(3) unsigned DEFAULT NULL,
  `event_type` varchar(100) NOT NULL,
  `old_queue_status` varchar(30) DEFAULT NULL,
  `new_queue_status` varchar(30) DEFAULT NULL,
  `meta_json` text DEFAULT NULL,
  `created_by` bigint(20) unsigned DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `idx_queue_events_lookup` (`fk_branch_id`,`fk_slot_id`,`appointment_date`,`created_at`),
  KEY `idx_queue_events_appointment` (`appointment_id`),
  CONSTRAINT `fk_queue_events_appointment` FOREIGN KEY (`appointment_id`) REFERENCES `tbl_appointments` (`appointment_id`),
  CONSTRAINT `fk_queue_events_branch` FOREIGN KEY (`fk_branch_id`) REFERENCES `master_clinic_branches` (`id`),
  CONSTRAINT `fk_queue_events_slot` FOREIGN KEY (`fk_slot_id`) REFERENCES `master_slots` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;
