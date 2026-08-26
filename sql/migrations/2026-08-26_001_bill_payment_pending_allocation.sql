-- Store whether a collection paid today's bill or older borrowed/pending,
-- and how much pending remained on that bill before and after the payment.

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
