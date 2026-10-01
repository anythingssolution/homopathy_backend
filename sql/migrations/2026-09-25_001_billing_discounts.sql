-- migration: retry-safe
-- migration: compatible-checksum 8343ba8b2adccfd81387dce99321cb4d33c4ba9c56d3cd6c07e38be6f53d4e96
-- migration: compatible-checksum 7c26574ca26773b5424578cd350ff3283df1928272b7455b9ec90b14764310f4
SET @migration_sql = IF(
  EXISTS(
    SELECT 1
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'tbl_bills'
      AND COLUMN_NAME = 'gross_amount'
  ),
  'SELECT 1',
  'ALTER TABLE tbl_bills ADD COLUMN gross_amount DECIMAL(10,2) NOT NULL DEFAULT 0.00 AFTER fk_branch_id'
);
PREPARE migration_statement FROM @migration_sql;
EXECUTE migration_statement;
DEALLOCATE PREPARE migration_statement;

SET @migration_sql = IF(
  EXISTS(
    SELECT 1
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'tbl_bills'
      AND COLUMN_NAME = 'discount_amount'
  ),
  'SELECT 1',
  'ALTER TABLE tbl_bills ADD COLUMN discount_amount DECIMAL(10,2) NOT NULL DEFAULT 0.00 AFTER gross_amount'
);
PREPARE migration_statement FROM @migration_sql;
EXECUTE migration_statement;
DEALLOCATE PREPARE migration_statement;

UPDATE tbl_bills
SET gross_amount = total_amount,
    discount_amount = 0.00
WHERE gross_amount = 0.00
  AND discount_amount = 0.00;

SET @migration_sql = IF(
  EXISTS(
    SELECT 1
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'tbl_medical_prescription_pricing'
      AND COLUMN_NAME = 'discounts_json'
  ),
  'SELECT 1',
  'ALTER TABLE tbl_medical_prescription_pricing ADD COLUMN discounts_json JSON NULL AFTER remark'
);
PREPARE migration_statement FROM @migration_sql;
EXECUTE migration_statement;
DEALLOCATE PREPARE migration_statement;

CREATE TABLE IF NOT EXISTS tbl_bill_discounts (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  bill_id BIGINT UNSIGNED NOT NULL,
  discount_category ENUM('CONSULTATION', 'MEDICINE', 'TEST', 'COURIER') NOT NULL,
  discount_type ENUM('AMOUNT') NOT NULL DEFAULT 'AMOUNT',
  discount_value DECIMAL(10,2) NOT NULL,
  discount_amount DECIMAL(10,2) NOT NULL,
  reason_code VARCHAR(60) NOT NULL,
  reason_note VARCHAR(255) NULL,
  status ENUM('ACTIVE', 'VOID') NOT NULL DEFAULT 'ACTIVE',
  created_by BIGINT UNSIGNED NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  voided_by BIGINT UNSIGNED NULL,
  voided_at TIMESTAMP NULL DEFAULT NULL,
  void_reason VARCHAR(255) NULL,
  PRIMARY KEY (id),
  KEY idx_bill_discounts_bill_status (bill_id, status),
  KEY idx_bill_discounts_category (discount_category, status),
  CONSTRAINT fk_bill_discounts_bill FOREIGN KEY (bill_id) REFERENCES tbl_bills (id),
  CONSTRAINT fk_bill_discounts_created_by FOREIGN KEY (created_by) REFERENCES master_users (id),
  CONSTRAINT fk_bill_discounts_voided_by FOREIGN KEY (voided_by) REFERENCES master_users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
