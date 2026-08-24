-- Overlay so dispensary can void a prescribed test without deleting the doctor's order.

SET @status_exists = (
  SELECT COUNT(*)
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'tbl_consultation_tests'
    AND COLUMN_NAME = 'dispense_status'
);

SET @status_ddl = IF(
  @status_exists = 0,
  'ALTER TABLE `tbl_consultation_tests`
     ADD COLUMN `dispense_status` ENUM(''ACTIVE'', ''VOID'') NOT NULL DEFAULT ''ACTIVE'' AFTER `amount`,
     ADD COLUMN `void_reason` VARCHAR(255) NULL AFTER `dispense_status`,
     ADD COLUMN `voided_by` BIGINT UNSIGNED NULL AFTER `void_reason`,
     ADD COLUMN `voided_at` TIMESTAMP NULL DEFAULT NULL AFTER `voided_by`,
     ADD COLUMN `version` INT UNSIGNED NOT NULL DEFAULT 1 AFTER `voided_at`',
  'SELECT 1'
);

PREPARE status_statement FROM @status_ddl;
EXECUTE status_statement;
DEALLOCATE PREPARE status_statement;

SET @fk_exists = (
  SELECT COUNT(*)
  FROM information_schema.TABLE_CONSTRAINTS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'tbl_consultation_tests'
    AND CONSTRAINT_NAME = 'fk_consultation_tests_voided_by'
);

SET @fk_ddl = IF(
  @fk_exists = 0,
  'ALTER TABLE `tbl_consultation_tests`
     ADD CONSTRAINT `fk_consultation_tests_voided_by`
     FOREIGN KEY (`voided_by`) REFERENCES `master_users` (`id`)',
  'SELECT 1'
);

PREPARE fk_statement FROM @fk_ddl;
EXECUTE fk_statement;
DEALLOCATE PREPARE fk_statement;

SET @idx_exists = (
  SELECT COUNT(*)
  FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'tbl_consultation_tests'
    AND INDEX_NAME = 'idx_consultation_tests_dispense_status'
);

SET @idx_ddl = IF(
  @idx_exists = 0,
  'ALTER TABLE `tbl_consultation_tests` ADD KEY `idx_consultation_tests_dispense_status` (`consultation_id`, `dispense_status`)',
  'SELECT 1'
);

PREPARE idx_statement FROM @idx_ddl;
EXECUTE idx_statement;
DEALLOCATE PREPARE idx_statement;
