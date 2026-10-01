-- migration: retry-safe
-- migration: compatible-checksum 92058fbe1a8585c33e6206d92d134ff30b778827e74af9552f7c77a41e363e24
-- migration: compatible-checksum 012c1c0556d6d0ceaf106c4b804cfad2014c2ada5301d1ca8092b554aef17996
SET @migration_sql = IF(
  EXISTS(
    SELECT 1
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'tbl_medical_prescription_pricing'
      AND COLUMN_NAME = 'delivery_mode'
  ),
  'SELECT 1',
  'ALTER TABLE tbl_medical_prescription_pricing ADD COLUMN delivery_mode VARCHAR(30) NOT NULL DEFAULT ''HAND_DELIVERY'' AFTER discounts_json'
);
PREPARE migration_statement FROM @migration_sql;
EXECUTE migration_statement;
DEALLOCATE PREPARE migration_statement;

SET @migration_sql = IF(
  EXISTS(
    SELECT 1
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'tbl_medical_prescription_pricing'
      AND COLUMN_NAME = 'courier_charge'
  ),
  'SELECT 1',
  'ALTER TABLE tbl_medical_prescription_pricing ADD COLUMN courier_charge DECIMAL(10,2) NOT NULL DEFAULT 0.00 AFTER delivery_mode'
);
PREPARE migration_statement FROM @migration_sql;
EXECUTE migration_statement;
DEALLOCATE PREPARE migration_statement;

SET @migration_sql = IF(
  EXISTS(
    SELECT 1
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'tbl_medical_prescription_pricing'
      AND COLUMN_NAME = 'delivery_details_json'
  ),
  'SELECT 1',
  'ALTER TABLE tbl_medical_prescription_pricing ADD COLUMN delivery_details_json JSON NULL AFTER courier_charge'
);
PREPARE migration_statement FROM @migration_sql;
EXECUTE migration_statement;
DEALLOCATE PREPARE migration_statement;
