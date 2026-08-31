-- Lab findings for prescribed tests. Sidecar table so Medical void/billing
-- on tbl_consultation_tests.version is never touched.

CREATE TABLE IF NOT EXISTS `tbl_consultation_test_findings` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `consultation_id` BIGINT UNSIGNED NOT NULL,
  `consultation_test_id` BIGINT UNSIGNED NOT NULL,
  `finding_text` VARCHAR(1000) NOT NULL,
  `notes` VARCHAR(2000) NULL,
  `interpreted_by` BIGINT UNSIGNED NOT NULL,
  `interpreted_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `created_by` BIGINT UNSIGNED NULL,
  `updated_by` BIGINT UNSIGNED NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_consultation_test_findings_test` (`consultation_test_id`),
  KEY `idx_consultation_test_findings_consultation` (`consultation_id`),
  CONSTRAINT `fk_consultation_test_findings_consultation`
    FOREIGN KEY (`consultation_id`) REFERENCES `tbl_consultations` (`id`)
    ON DELETE CASCADE,
  CONSTRAINT `fk_consultation_test_findings_test`
    FOREIGN KEY (`consultation_test_id`) REFERENCES `tbl_consultation_tests` (`id`)
    ON DELETE CASCADE,
  CONSTRAINT `fk_consultation_test_findings_interpreted_by`
    FOREIGN KEY (`interpreted_by`) REFERENCES `master_users` (`id`),
  CONSTRAINT `fk_consultation_test_findings_created_by`
    FOREIGN KEY (`created_by`) REFERENCES `master_users` (`id`),
  CONSTRAINT `fk_consultation_test_findings_updated_by`
    FOREIGN KEY (`updated_by`) REFERENCES `master_users` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
