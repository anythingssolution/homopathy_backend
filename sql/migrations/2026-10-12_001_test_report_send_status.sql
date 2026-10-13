-- migration: retry-safe

CREATE TABLE IF NOT EXISTS `tbl_test_report_send_status` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `source_type` ENUM('CONSULTATION', 'BILL') NOT NULL,
  `source_id` BIGINT UNSIGNED NOT NULL,
  `status` ENUM('SENT', 'NOT_SENT') NOT NULL,
  `not_sent_reason` VARCHAR(500) NULL,
  `marked_by` BIGINT UNSIGNED NULL,
  `marked_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_test_report_send_source` (`source_type`, `source_id`),
  KEY `idx_test_report_send_status` (`status`, `marked_at`),
  KEY `idx_test_report_send_marked_by` (`marked_by`),
  CONSTRAINT `fk_test_report_send_marked_by`
    FOREIGN KEY (`marked_by`) REFERENCES `master_users` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
