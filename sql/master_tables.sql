------------------ roles table ------------------

CREATE TABLE IF NOT EXISTS `master_roles` (
  `role_id` int(11) NOT NULL AUTO_INCREMENT,
  `role_name` varchar(50) NOT NULL,
  `role_code` varchar(20) DEFAULT NULL,
  `status` tinyint(4) DEFAULT 1,
  `created_at` timestamp NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`role_id`),
  UNIQUE KEY `role_code` (`role_code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

INSERT INTO `master_roles` (`role_name`, `role_code`, `status`)
VALUES
  ('Doctor', 'DOC', 1),
  ('Receptionist', 'REC', 1),
  ('Medical', 'MED', 1),
  ('Patient', 'PAT', 1)
ON DUPLICATE KEY UPDATE
  `role_name` = VALUES(`role_name`),
  `status` = VALUES(`status`);

------------------- clinic branches, treatments, and slots tables ------------------

CREATE TABLE `master_clinic_branches` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `branch_name` varchar(150) NOT NULL,
  `address` text NOT NULL,
  `contact_no` bigint(15) DEFAULT NULL,
  `is_active` tinyint(1) DEFAULT 1,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  `created_by` bigint(20) unsigned DEFAULT NULL,
  `updated_by` bigint(20) unsigned DEFAULT NULL,
  `created_ip` varchar(45) NOT NULL,
  `updated_ip` varchar(45) DEFAULT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB AUTO_INCREMENT=3 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;


CREATE TABLE `master_treatments` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `treatment_code` varchar(50) DEFAULT NULL,
  `treatment_name` varchar(150) NOT NULL,
  `description` text DEFAULT NULL,
  `estimated_duration_minutes` decimal(5,2) DEFAULT NULL COMMENT 'Duration in minutes',
  `is_active` tinyint(1) DEFAULT 1,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  `created_by` bigint(20) unsigned DEFAULT NULL,
  `updated_by` bigint(20) unsigned DEFAULT NULL,
  `created_ip` varchar(45) NOT NULL,
  `updated_ip` varchar(45) DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_master_treatments_code` (`treatment_code`)
) ENGINE=InnoDB AUTO_INCREMENT=5 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;



CREATE TABLE `master_slots` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `fk_branch_id` bigint(20) unsigned NOT NULL,
  `slot_name` varchar(100) NOT NULL COMMENT 'e.g. Morning Session, Evening Session',
  `start_time` time NOT NULL,
  `end_time` time NOT NULL,
  `default_consult_minutes` int(11) NOT NULL DEFAULT 15,
  `is_active` tinyint(1) DEFAULT 1,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  `created_by` bigint(20) unsigned DEFAULT NULL,
  `updated_by` bigint(20) unsigned DEFAULT NULL,
  `created_ip` varchar(45) NOT NULL,
  `updated_ip` varchar(45) DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `fk_slot_branch` (`fk_branch_id`),
  CONSTRAINT `fk_slot_branch` FOREIGN KEY (`fk_branch_id`) REFERENCES `master_clinic_branches` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=5 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;
