-- Manual ALTER for bill payment current vs previous-pending allocation.
-- Run this on the same database the API uses (DB_NAME in .env).
-- Safe to run more than once: it only adds missing columns / keys.
--
-- Matching migration: sql/migrations/2026-08-26_001_bill_payment_pending_allocation.sql
--
-- Adds on tbl_bill_payments:
--   allocation_kind            CURRENT | PREVIOUS
--   settlement_source_bill_id  the older bill whose pending was collected
--   pending_before / pending_after  pending on that bill around this payment

-- 1) Allocation columns
SET @kind_exists = (
  SELECT COUNT(*)
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'tbl_bill_payments'
    AND COLUMN_NAME = 'allocation_kind'
);

SET @kind_ddl = IF(
  @kind_exists = 0,
  'ALTER TABLE `tbl_bill_payments`
     ADD COLUMN `allocation_kind` VARCHAR(20) NOT NULL DEFAULT ''CURRENT'' AFTER `payment_for`,
     ADD COLUMN `settlement_source_bill_id` BIGINT UNSIGNED NULL AFTER `allocation_kind`,
     ADD COLUMN `pending_before` DECIMAL(10,2) NULL AFTER `amount`,
     ADD COLUMN `pending_after` DECIMAL(10,2) NULL AFTER `pending_before`',
  'SELECT 1'
);

PREPARE kind_statement FROM @kind_ddl;
EXECUTE kind_statement;
DEALLOCATE PREPARE kind_statement;

-- 2) Lookup by the older bill that was settled
SET @settlement_index_exists = (
  SELECT COUNT(*)
  FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'tbl_bill_payments'
    AND INDEX_NAME = 'idx_tbl_bill_payments_settlement_source'
);

SET @settlement_index_ddl = IF(
  @settlement_index_exists = 0,
  'ALTER TABLE `tbl_bill_payments` ADD KEY `idx_tbl_bill_payments_settlement_source` (`settlement_source_bill_id`)',
  'SELECT 1'
);

PREPARE settlement_index_statement FROM @settlement_index_ddl;
EXECUTE settlement_index_statement;
DEALLOCATE PREPARE settlement_index_statement;

-- 3) FK to tbl_bills
SET @fk_exists = (
  SELECT COUNT(*)
  FROM information_schema.TABLE_CONSTRAINTS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'tbl_bill_payments'
    AND CONSTRAINT_NAME = 'fk_tbl_bill_payments_settlement_source'
);

SET @fk_ddl = IF(
  @fk_exists = 0,
  'ALTER TABLE `tbl_bill_payments`
     ADD CONSTRAINT `fk_tbl_bill_payments_settlement_source`
     FOREIGN KEY (`settlement_source_bill_id`) REFERENCES `tbl_bills` (`id`)',
  'SELECT 1'
);

PREPARE fk_statement FROM @fk_ddl;
EXECUTE fk_statement;
DEALLOCATE PREPARE fk_statement;

-- 4) Confirm columns exist
SELECT COLUMN_NAME, COLUMN_TYPE, COLUMN_DEFAULT
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME = 'tbl_bill_payments'
  AND COLUMN_NAME IN ('allocation_kind', 'settlement_source_bill_id', 'pending_before', 'pending_after')
ORDER BY ORDINAL_POSITION;
