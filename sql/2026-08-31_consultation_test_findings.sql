-- Lab findings for prescribed consultation tests.
-- Table: tbl_consultation_test_findings
-- Matching migration: sql/migrations/2026-08-31_001_consultation_test_findings.sql
--
-- Safe to run more than once: it only creates the table if missing.
-- Run this against the API database (DB_NAME in .env).
-- Does not change tbl_consultation_tests, Medical void, or billing.

SET @table_exists = (
  SELECT COUNT(*)
  FROM information_schema.TABLES
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'tbl_consultation_test_findings'
);

SET @table_ddl = IF(
  @table_exists = 0,
  'CREATE TABLE `tbl_consultation_test_findings` (
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
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci',
  'SELECT 1'
);

PREPARE table_statement FROM @table_ddl;
EXECUTE table_statement;
DEALLOCATE PREPARE table_statement;

SELECT TABLE_NAME, ENGINE, TABLE_COLLATION
FROM information_schema.TABLES
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME = 'tbl_consultation_test_findings';

SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_KEY
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME = 'tbl_consultation_test_findings'
ORDER BY ORDINAL_POSITION;
