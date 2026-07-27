ALTER TABLE `master_treatments`
  ADD COLUMN IF NOT EXISTS `treatment_code` VARCHAR(50) NULL AFTER `id`;

ALTER TABLE `tbl_appointments`
  MODIFY COLUMN `assigned_slot_duration_minutes` DECIMAL(5,2) UNSIGNED NULL;

UPDATE `master_treatments`
SET `treatment_code` = CASE `treatment_name`
  WHEN 'First Consultation' THEN 'FIRST_CONSULTATION'
  WHEN 'Follow-up Visit' THEN 'FOLLOW_UP_VISIT'
  WHEN 'Acute Treatment' THEN 'ACUTE_TREATMENT'
  WHEN 'Chronic Case Discussion' THEN 'CHRONIC_CASE_DISCUSSION'
  ELSE `treatment_code`
END
WHERE `treatment_name` IN (
  'First Consultation',
  'Follow-up Visit',
  'Acute Treatment',
  'Chronic Case Discussion'
);

ALTER TABLE `master_treatments`
  ADD UNIQUE KEY `uq_master_treatments_code` (`treatment_code`);

CREATE TABLE IF NOT EXISTS `master_token_extension_mix` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `fk_treatment_id` BIGINT UNSIGNED NOT NULL,
  `token_count` SMALLINT UNSIGNED NOT NULL,
  `display_order` SMALLINT UNSIGNED NOT NULL DEFAULT 1,
  `is_active` TINYINT(1) NOT NULL DEFAULT 1,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `created_by` BIGINT UNSIGNED NULL,
  `updated_by` BIGINT UNSIGNED NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_extension_mix_treatment` (`fk_treatment_id`),
  CONSTRAINT `fk_extension_mix_treatment`
    FOREIGN KEY (`fk_treatment_id`) REFERENCES `master_treatments` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

INSERT INTO `master_token_extension_mix`
  (`fk_treatment_id`, `token_count`, `display_order`, `is_active`)
SELECT `id`,
       CASE `treatment_code`
         WHEN 'ACUTE_TREATMENT' THEN 2
         WHEN 'FIRST_CONSULTATION' THEN 2
         WHEN 'FOLLOW_UP_VISIT' THEN 8
       END,
       CASE `treatment_code`
         WHEN 'ACUTE_TREATMENT' THEN 1
         WHEN 'FIRST_CONSULTATION' THEN 2
         WHEN 'FOLLOW_UP_VISIT' THEN 3
       END,
       1
FROM `master_treatments`
WHERE `treatment_code` IN (
  'ACUTE_TREATMENT',
  'FIRST_CONSULTATION',
  'FOLLOW_UP_VISIT'
)
ON DUPLICATE KEY UPDATE
  `token_count` = VALUES(`token_count`),
  `display_order` = VALUES(`display_order`),
  `is_active` = 1;

CREATE TABLE IF NOT EXISTS `tbl_slot_token_extensions` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `fk_branch_id` BIGINT UNSIGNED NOT NULL,
  `fk_slot_id` BIGINT UNSIGNED NOT NULL,
  `appointment_date` DATE NOT NULL,
  `block_number` TINYINT UNSIGNED NOT NULL,
  `base_token_count` SMALLINT UNSIGNED NOT NULL,
  `extra_token_count` SMALLINT UNSIGNED NOT NULL,
  `total_duration_seconds` INT UNSIGNED NOT NULL,
  `status` ENUM('ACTIVE', 'CANCELLED') NOT NULL DEFAULT 'ACTIVE',
  `active_context_key` VARCHAR(100)
    GENERATED ALWAYS AS (
      CASE
        WHEN `status` = 'ACTIVE'
        THEN CONCAT(
          `fk_branch_id`, ':', `fk_slot_id`, ':', `appointment_date`, ':', `block_number`
        )
        ELSE NULL
      END
    ) STORED,
  `created_by` BIGINT UNSIGNED NOT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `cancelled_by` BIGINT UNSIGNED NULL,
  `cancelled_at` TIMESTAMP NULL,
  `cancellation_reason` VARCHAR(500) NULL,
  `created_ip` VARCHAR(45) NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_active_slot_token_extension` (`active_context_key`),
  KEY `idx_slot_extension_context`
    (`fk_branch_id`, `fk_slot_id`, `appointment_date`, `status`),
  CONSTRAINT `fk_slot_extension_branch`
    FOREIGN KEY (`fk_branch_id`) REFERENCES `master_clinic_branches` (`id`),
  CONSTRAINT `fk_slot_extension_slot`
    FOREIGN KEY (`fk_slot_id`) REFERENCES `master_slots` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `tbl_slot_extension_tokens` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `fk_extension_id` BIGINT UNSIGNED NOT NULL,
  `token_number` SMALLINT UNSIGNED NOT NULL,
  `sequence_number` SMALLINT UNSIGNED NOT NULL,
  `fk_treatment_id` BIGINT UNSIGNED NOT NULL,
  `treatment_code_snapshot` VARCHAR(50) NOT NULL,
  `treatment_name_snapshot` VARCHAR(150) NOT NULL,
  `duration_seconds` INT UNSIGNED NOT NULL,
  `estimated_start_time` TIME NOT NULL,
  `estimated_end_time` TIME NOT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_extension_token_number` (`fk_extension_id`, `token_number`),
  UNIQUE KEY `uq_extension_token_sequence` (`fk_extension_id`, `sequence_number`),
  CONSTRAINT `fk_extension_token_header`
    FOREIGN KEY (`fk_extension_id`) REFERENCES `tbl_slot_token_extensions` (`id`),
  CONSTRAINT `fk_extension_token_treatment`
    FOREIGN KEY (`fk_treatment_id`) REFERENCES `master_treatments` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `tbl_slot_token_extension_audit_logs` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `fk_extension_id` BIGINT UNSIGNED NULL,
  `action` VARCHAR(40) NOT NULL,
  `old_data_json` JSON NULL,
  `new_data_json` JSON NULL,
  `performed_by` BIGINT UNSIGNED NOT NULL,
  `performed_by_role` VARCHAR(20) NOT NULL,
  `performed_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `ip_address` VARCHAR(45) NULL,
  PRIMARY KEY (`id`),
  KEY `idx_extension_audit` (`fk_extension_id`, `performed_at`),
  CONSTRAINT `fk_extension_audit_header`
    FOREIGN KEY (`fk_extension_id`) REFERENCES `tbl_slot_token_extensions` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
