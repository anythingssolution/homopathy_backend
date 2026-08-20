-- Database Migration for WhatsApp Automation, Follow-up Reminders & Doctor Settings
-- Database: homopathy_clinic

-- 1. Doctor-Level WhatsApp Automation Settings
CREATE TABLE IF NOT EXISTS `tbl_whatsapp_doctor_settings` (
  `doctor_id` BIGINT(20) UNSIGNED NOT NULL,
  `whatsapp_automation_enabled` TINYINT(1) NOT NULL DEFAULT 1,
  `followup_reminders_enabled` TINYINT(1) NOT NULL DEFAULT 1,
  `prescription_sharing_enabled` TINYINT(1) NOT NULL DEFAULT 1,
  `appointment_confirmation_enabled` TINYINT(1) NOT NULL DEFAULT 1,
  `reminder_time_x_minus_1` TIME NOT NULL DEFAULT '10:00:00',
  `reminder_time_x` TIME NOT NULL DEFAULT '09:00:00',
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`doctor_id`),
  CONSTRAINT `fk_wa_settings_doctor` FOREIGN KEY (`doctor_id`) REFERENCES `master_users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 2. Persistent Scheduled WhatsApp Messages Queue
CREATE TABLE IF NOT EXISTS `tbl_whatsapp_scheduled_messages` (
  `id` BIGINT(20) UNSIGNED NOT NULL AUTO_INCREMENT,
  `fk_consultation_id` BIGINT(20) UNSIGNED DEFAULT NULL,
  `fk_appointment_id` BIGINT(20) UNSIGNED DEFAULT NULL,
  `fk_patient_id` BIGINT(20) UNSIGNED NOT NULL,
  `fk_doctor_id` BIGINT(20) UNSIGNED DEFAULT NULL,
  `fk_branch_id` BIGINT(20) UNSIGNED DEFAULT NULL,
  `recipient_phone` VARCHAR(20) NOT NULL,
  `recipient_name` VARCHAR(150) NOT NULL,
  `recipient_type` ENUM('PATIENT', 'FAMILY_MEMBER') NOT NULL DEFAULT 'PATIENT',
  `family_member_id` BIGINT(20) UNSIGNED DEFAULT NULL,
  `message_type` ENUM('TEXT', 'TEMPLATE', 'DOCUMENT') NOT NULL DEFAULT 'TEMPLATE',
  `template_name` VARCHAR(100) DEFAULT NULL,
  `template_parameters_json` JSON DEFAULT NULL,
  `media_url` VARCHAR(500) DEFAULT NULL,
  `media_filename` VARCHAR(255) DEFAULT NULL,
  `custom_message_text` TEXT DEFAULT NULL,
  `trigger_event` ENUM('FOLLOWUP_X_MINUS_1', 'FOLLOWUP_X', 'APPOINTMENT_CONFIRMATION', 'PRESCRIPTION_SHARE', 'CUSTOM') NOT NULL,
  `target_date` DATE NOT NULL,
  `scheduled_at` DATETIME NOT NULL,
  `status` ENUM('PENDING', 'PROCESSING', 'SENT', 'CANCELLED', 'FAILED') NOT NULL DEFAULT 'PENDING',
  `idempotency_key` VARCHAR(150) NOT NULL,
  `attempt_count` INT NOT NULL DEFAULT 0,
  `max_attempts` INT NOT NULL DEFAULT 3,
  `last_error` TEXT DEFAULT NULL,
  `sent_at` DATETIME DEFAULT NULL,
  `provider_message_id` VARCHAR(150) DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_wa_sched_idempotency` (`idempotency_key`),
  KEY `idx_wa_sched_due` (`scheduled_at`, `status`),
  KEY `idx_wa_sched_consultation` (`fk_consultation_id`, `status`),
  KEY `idx_wa_sched_appointment` (`fk_appointment_id`, `status`),
  KEY `idx_wa_sched_patient` (`fk_patient_id`),
  CONSTRAINT `fk_wa_sched_patient` FOREIGN KEY (`fk_patient_id`) REFERENCES `master_users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 3. Additional System Templates for Automation
INSERT INTO `tbl_whatsapp_templates`
  (`template_name`, `language_code`, `category`, `body_template`, `parameter_mapping_json`, `approval_status`, `is_active`)
VALUES
  (
    'followup_reminder_day_before',
    'en',
    'UTILITY',
    'Hello {{patient_name}}, this is a friendly reminder from Dr. {{doctor_name}} ({{branch_name}}). Your follow-up visit is scheduled for tomorrow, {{follow_up_date}}.',
    '["patient_name", "doctor_name", "branch_name", "follow_up_date"]',
    'APPROVED',
    1
  ),
  (
    'followup_reminder_today',
    'en',
    'UTILITY',
    'Hello {{patient_name}}, your follow-up visit with Dr. {{doctor_name}} at {{branch_name}} is due today, {{follow_up_date}}. Please visit during clinic consultation hours.',
    '["patient_name", "doctor_name", "branch_name", "follow_up_date"]',
    'APPROVED',
    1
  ),
  (
    'prescription_ready_share',
    'en',
    'UTILITY',
    'Dear {{recipient_name}}, here is the digital prescription from Dr. {{doctor_name}} for {{patient_name}} (Visit Date: {{visit_date}}). Access link: {{document_url}}',
    '["recipient_name", "doctor_name", "patient_name", "visit_date", "document_url"]',
    'APPROVED',
    1
  )
ON DUPLICATE KEY UPDATE
  `body_template` = VALUES(`body_template`),
  `parameter_mapping_json` = VALUES(`parameter_mapping_json`),
  `updated_at` = CURRENT_TIMESTAMP;
