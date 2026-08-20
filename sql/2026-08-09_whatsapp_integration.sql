-- Database Migration Script for WhatsApp Business Integration
-- Database: homopathy_clinic

-- 1. Extend master_users with WhatsApp fields
ALTER TABLE `master_users`
  ADD COLUMN IF NOT EXISTS `whatsapp_number` VARCHAR(20) NULL AFTER `mobile_no`,
  ADD COLUMN IF NOT EXISTS `whatsapp_consent_status` ENUM('OPTED_IN', 'OPTED_OUT', 'UNSPECIFIED') NOT NULL DEFAULT 'OPTED_IN' AFTER `whatsapp_number`,
  ADD COLUMN IF NOT EXISTS `whatsapp_consent_updated_at` DATETIME NULL AFTER `whatsapp_consent_status`,
  ADD COLUMN IF NOT EXISTS `last_whatsapp_delivery_at` DATETIME NULL AFTER `whatsapp_consent_updated_at`;

-- 2. WhatsApp Message Templates Registry
CREATE TABLE IF NOT EXISTS `tbl_whatsapp_templates` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `template_name` varchar(100) NOT NULL,
  `language_code` varchar(10) NOT NULL DEFAULT 'en',
  `category` enum('UTILITY', 'MARKETING', 'AUTHENTICATION') NOT NULL DEFAULT 'UTILITY',
  `body_template` text NOT NULL,
  `parameter_mapping_json` json DEFAULT NULL,
  `approval_status` enum('APPROVED', 'PENDING', 'REJECTED') NOT NULL DEFAULT 'APPROVED',
  `is_active` tinyint(1) NOT NULL DEFAULT 1,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `created_by` bigint(20) unsigned DEFAULT NULL,
  `updated_by` bigint(20) unsigned DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_template_lang` (`template_name`, `language_code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Seed default templates
INSERT INTO `tbl_whatsapp_templates`
  (`template_name`, `language_code`, `category`, `body_template`, `parameter_mapping_json`, `approval_status`, `is_active`)
VALUES
  (
    'appointment_confirmation',
    'en',
    'UTILITY',
    'Hello {{patient_name}}, your appointment with Dr. {{doctor_name}} is confirmed for {{appointment_date}} at {{appointment_time}} at {{branch_name}}. Token: {{token_number}}.',
    '["patient_name", "doctor_name", "appointment_date", "appointment_time", "branch_name", "token_number"]',
    'APPROVED',
    1
  ),
  (
    'appointment_reminder',
    'en',
    'UTILITY',
    'Reminder: Dear {{patient_name}}, your appointment at {{branch_name}} is scheduled for {{appointment_date}} at {{appointment_time}}. Please arrive 10 mins early.',
    '["patient_name", "branch_name", "appointment_date", "appointment_time"]',
    'APPROVED',
    1
  ),
  (
    'prescription_available',
    'en',
    'UTILITY',
    'Dear {{patient_name}}, your prescription from Dr. {{doctor_name}} is ready. View secure document: {{document_url}}',
    '["patient_name", "doctor_name", "document_url"]',
    'APPROVED',
    1
  ),
  (
    'invoice_notification',
    'en',
    'UTILITY',
    'Dear {{patient_name}}, your consultation invoice #{{invoice_number}} for {{amount}} is generated. View invoice: {{document_url}}',
    '["patient_name", "invoice_number", "amount", "document_url"]',
    'APPROVED',
    1
  ),
  (
    'clinic_notice',
    'en',
    'UTILITY',
    'Notice from {{branch_name}}: {{message_text}}',
    '["branch_name", "message_text"]',
    'APPROVED',
    1
  )
ON DUPLICATE KEY UPDATE
  `body_template` = VALUES(`body_template`),
  `updated_at` = CURRENT_TIMESTAMP;

-- 3. WhatsApp Messages Audit History
CREATE TABLE IF NOT EXISTS `tbl_whatsapp_messages` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `fk_patient_id` bigint(20) unsigned NOT NULL,
  `fk_doctor_id` bigint(20) unsigned DEFAULT NULL,
  `fk_branch_id` bigint(20) unsigned DEFAULT NULL,
  `fk_appointment_id` bigint(20) unsigned DEFAULT NULL,
  `fk_prescription_id` bigint(20) unsigned DEFAULT NULL,
  `fk_bill_id` bigint(20) unsigned DEFAULT NULL,
  `message_type` enum('TEXT', 'TEMPLATE', 'DOCUMENT', 'IMAGE') NOT NULL DEFAULT 'TEXT',
  `template_name` varchar(100) DEFAULT NULL,
  `recipient_phone` varchar(20) NOT NULL,
  `message_text` text DEFAULT NULL,
  `media_url` varchar(500) DEFAULT NULL,
  `provider_message_id` varchar(150) DEFAULT NULL,
  `status` enum('queued', 'sending', 'sent', 'delivered', 'read', 'failed') NOT NULL DEFAULT 'queued',
  `error_code` varchar(50) DEFAULT NULL,
  `error_message` text DEFAULT NULL,
  `sent_at` datetime DEFAULT NULL,
  `delivered_at` datetime DEFAULT NULL,
  `read_at` datetime DEFAULT NULL,
  `failed_at` datetime DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `created_by` bigint(20) unsigned DEFAULT NULL,
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

-- 4. WhatsApp Webhook Events Log (Idempotency)
CREATE TABLE IF NOT EXISTS `tbl_whatsapp_webhook_events` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `provider_message_id` varchar(150) NOT NULL,
  `event_type` enum('sent', 'delivered', 'read', 'failed', 'inbound_message') NOT NULL,
  `raw_payload_json` json NOT NULL,
  `is_processed` tinyint(1) NOT NULL DEFAULT 0,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_provider_event` (`provider_message_id`, `event_type`),
  KEY `idx_webhook_processed` (`is_processed`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
