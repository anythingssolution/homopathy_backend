-- WhatsApp integration + reminder queue. Legacy files in sql/ were never
-- applied by the managed runner, so local/dev databases were missing the tables.

SET @whatsapp_number_exists = (
  SELECT COUNT(*)
  FROM `information_schema`.`COLUMNS`
  WHERE `TABLE_SCHEMA` = DATABASE()
    AND `TABLE_NAME` = 'master_users'
    AND `COLUMN_NAME` = 'whatsapp_number'
);
SET @whatsapp_number_ddl = IF(
  @whatsapp_number_exists = 0,
  'ALTER TABLE `master_users` ADD COLUMN `whatsapp_number` VARCHAR(20) NULL AFTER `mobile_no`',
  'SELECT 1'
);
PREPARE whatsapp_number_statement FROM @whatsapp_number_ddl;
EXECUTE whatsapp_number_statement;
DEALLOCATE PREPARE whatsapp_number_statement;

SET @whatsapp_consent_exists = (
  SELECT COUNT(*)
  FROM `information_schema`.`COLUMNS`
  WHERE `TABLE_SCHEMA` = DATABASE()
    AND `TABLE_NAME` = 'master_users'
    AND `COLUMN_NAME` = 'whatsapp_consent_status'
);
SET @whatsapp_consent_ddl = IF(
  @whatsapp_consent_exists = 0,
  'ALTER TABLE `master_users` ADD COLUMN `whatsapp_consent_status` ENUM(''OPTED_IN'', ''OPTED_OUT'', ''UNSPECIFIED'') NOT NULL DEFAULT ''OPTED_IN'' AFTER `whatsapp_number`',
  'SELECT 1'
);
PREPARE whatsapp_consent_statement FROM @whatsapp_consent_ddl;
EXECUTE whatsapp_consent_statement;
DEALLOCATE PREPARE whatsapp_consent_statement;

SET @whatsapp_consent_updated_exists = (
  SELECT COUNT(*)
  FROM `information_schema`.`COLUMNS`
  WHERE `TABLE_SCHEMA` = DATABASE()
    AND `TABLE_NAME` = 'master_users'
    AND `COLUMN_NAME` = 'whatsapp_consent_updated_at'
);
SET @whatsapp_consent_updated_ddl = IF(
  @whatsapp_consent_updated_exists = 0,
  'ALTER TABLE `master_users` ADD COLUMN `whatsapp_consent_updated_at` DATETIME NULL AFTER `whatsapp_consent_status`',
  'SELECT 1'
);
PREPARE whatsapp_consent_updated_statement FROM @whatsapp_consent_updated_ddl;
EXECUTE whatsapp_consent_updated_statement;
DEALLOCATE PREPARE whatsapp_consent_updated_statement;

SET @last_whatsapp_delivery_exists = (
  SELECT COUNT(*)
  FROM `information_schema`.`COLUMNS`
  WHERE `TABLE_SCHEMA` = DATABASE()
    AND `TABLE_NAME` = 'master_users'
    AND `COLUMN_NAME` = 'last_whatsapp_delivery_at'
);
SET @last_whatsapp_delivery_ddl = IF(
  @last_whatsapp_delivery_exists = 0,
  'ALTER TABLE `master_users` ADD COLUMN `last_whatsapp_delivery_at` DATETIME NULL AFTER `whatsapp_consent_updated_at`',
  'SELECT 1'
);
PREPARE last_whatsapp_delivery_statement FROM @last_whatsapp_delivery_ddl;
EXECUTE last_whatsapp_delivery_statement;
DEALLOCATE PREPARE last_whatsapp_delivery_statement;

CREATE TABLE IF NOT EXISTS `tbl_whatsapp_templates` (
  `id` BIGINT(20) UNSIGNED NOT NULL AUTO_INCREMENT,
  `template_name` VARCHAR(100) NOT NULL,
  `language_code` VARCHAR(10) NOT NULL DEFAULT 'en',
  `category` ENUM('UTILITY', 'MARKETING', 'AUTHENTICATION') NOT NULL DEFAULT 'UTILITY',
  `body_template` TEXT NOT NULL,
  `parameter_mapping_json` JSON DEFAULT NULL,
  `approval_status` ENUM('APPROVED', 'PENDING', 'REJECTED') NOT NULL DEFAULT 'APPROVED',
  `is_active` TINYINT(1) NOT NULL DEFAULT 1,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `created_by` BIGINT(20) UNSIGNED DEFAULT NULL,
  `updated_by` BIGINT(20) UNSIGNED DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_template_lang` (`template_name`, `language_code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `tbl_whatsapp_messages` (
  `id` BIGINT(20) UNSIGNED NOT NULL AUTO_INCREMENT,
  `fk_patient_id` BIGINT(20) UNSIGNED NOT NULL,
  `fk_doctor_id` BIGINT(20) UNSIGNED DEFAULT NULL,
  `fk_branch_id` BIGINT(20) UNSIGNED DEFAULT NULL,
  `fk_appointment_id` BIGINT(20) UNSIGNED DEFAULT NULL,
  `fk_prescription_id` BIGINT(20) UNSIGNED DEFAULT NULL,
  `fk_bill_id` BIGINT(20) UNSIGNED DEFAULT NULL,
  `message_type` ENUM('TEXT', 'TEMPLATE', 'DOCUMENT', 'IMAGE') NOT NULL DEFAULT 'TEXT',
  `template_name` VARCHAR(100) DEFAULT NULL,
  `recipient_phone` VARCHAR(20) NOT NULL,
  `message_text` TEXT DEFAULT NULL,
  `media_url` VARCHAR(500) DEFAULT NULL,
  `provider_message_id` VARCHAR(150) DEFAULT NULL,
  `status` ENUM('queued', 'sending', 'sent', 'delivered', 'read', 'failed') NOT NULL DEFAULT 'queued',
  `error_code` VARCHAR(50) DEFAULT NULL,
  `error_message` TEXT DEFAULT NULL,
  `sent_at` DATETIME DEFAULT NULL,
  `delivered_at` DATETIME DEFAULT NULL,
  `read_at` DATETIME DEFAULT NULL,
  `failed_at` DATETIME DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `created_by` BIGINT(20) UNSIGNED DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_wa_patient` (`fk_patient_id`),
  KEY `idx_wa_doctor` (`fk_doctor_id`),
  KEY `idx_wa_branch` (`fk_branch_id`),
  KEY `idx_wa_appointment` (`fk_appointment_id`),
  KEY `idx_wa_provider_msg` (`provider_message_id`),
  KEY `idx_wa_status` (`status`),
  KEY `idx_wa_created` (`created_at`),
  CONSTRAINT `fk_wa_msg_patient` FOREIGN KEY (`fk_patient_id`) REFERENCES `master_users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `tbl_whatsapp_webhook_events` (
  `id` BIGINT(20) UNSIGNED NOT NULL AUTO_INCREMENT,
  `provider_message_id` VARCHAR(150) NOT NULL,
  `event_type` ENUM('sent', 'delivered', 'read', 'failed', 'inbound_message') NOT NULL,
  `raw_payload_json` JSON NOT NULL,
  `is_processed` TINYINT(1) NOT NULL DEFAULT 0,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_provider_event` (`provider_message_id`, `event_type`),
  KEY `idx_webhook_processed` (`is_processed`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

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

INSERT INTO `tbl_whatsapp_templates`
  (`template_name`, `language_code`, `category`, `body_template`, `parameter_mapping_json`, `approval_status`, `is_active`)
VALUES
  ('appointment_confirmation', 'en', 'UTILITY', 'Hello {{patient_name}}, your appointment with Dr. {{doctor_name}} is confirmed for {{appointment_date}} at {{appointment_time}} at {{branch_name}}. Token: {{token_number}}.', '["patient_name", "doctor_name", "appointment_date", "appointment_time", "branch_name", "token_number"]', 'APPROVED', 1),
  ('appointment_reminder', 'en', 'UTILITY', 'Reminder: Dear {{patient_name}}, your appointment at {{branch_name}} is scheduled for {{appointment_date}} at {{appointment_time}}. Please arrive 10 mins early.', '["patient_name", "branch_name", "appointment_date", "appointment_time"]', 'APPROVED', 1),
  ('prescription_available', 'en', 'UTILITY', 'Dear {{patient_name}}, your prescription from Dr. {{doctor_name}} is ready. View secure document: {{document_url}}', '["patient_name", "doctor_name", "document_url"]', 'APPROVED', 1),
  ('invoice_notification', 'en', 'UTILITY', 'Dear {{patient_name}}, your consultation invoice #{{invoice_number}} for {{amount}} is generated. View invoice: {{document_url}}', '["patient_name", "invoice_number", "amount", "document_url"]', 'APPROVED', 1),
  ('clinic_notice', 'en', 'UTILITY', 'Notice from {{branch_name}}: {{message_text}}', '["branch_name", "message_text"]', 'APPROVED', 1),
  ('followup_reminder_day_before', 'en', 'UTILITY', 'Hello {{patient_name}}, this is a friendly reminder from Dr. {{doctor_name}} ({{branch_name}}). Your follow-up visit is scheduled for tomorrow, {{follow_up_date}}.', '["patient_name", "doctor_name", "branch_name", "follow_up_date"]', 'APPROVED', 1),
  ('followup_reminder_today', 'en', 'UTILITY', 'Hello {{patient_name}}, your follow-up visit with Dr. {{doctor_name}} at {{branch_name}} is due today, {{follow_up_date}}. Please visit during clinic consultation hours.', '["patient_name", "doctor_name", "branch_name", "follow_up_date"]', 'APPROVED', 1),
  ('prescription_ready_share', 'en', 'UTILITY', 'Dear {{recipient_name}}, here is the digital prescription from Dr. {{doctor_name}} for {{patient_name}} (Visit Date: {{visit_date}}). Access link: {{document_url}}', '["recipient_name", "doctor_name", "patient_name", "visit_date", "document_url"]', 'APPROVED', 1)
ON DUPLICATE KEY UPDATE
  `body_template` = VALUES(`body_template`),
  `parameter_mapping_json` = VALUES(`parameter_mapping_json`),
  `is_active` = 1,
  `updated_at` = CURRENT_TIMESTAMP;
