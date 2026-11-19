-- migration: retry-safe
-- Preserve existing enum members; extend only when needed (MySQL and MariaDB).
SET @dispense_status_type = (SELECT COLUMN_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tbl_consultations' AND COLUMN_NAME = 'workflow_status');
SET @dispense_status_ddl = IF(LEFT(@dispense_status_type, 5) = 'enum(' AND LOCATE('DISPENSE_CANCELLED', @dispense_status_type) = 0,
 CONCAT('ALTER TABLE tbl_consultations MODIFY COLUMN workflow_status ', LEFT(@dispense_status_type, LENGTH(@dispense_status_type)-1), ',''DISPENSE_CANCELLED'') NOT NULL DEFAULT ''DRAFT'''), 'SELECT 1');
PREPARE dispense_status_stmt FROM @dispense_status_ddl;
EXECUTE dispense_status_stmt;
DEALLOCATE PREPARE dispense_status_stmt;
SET @dispense_cancel_ddl = IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tbl_consultations' AND COLUMN_NAME = 'dispense_cancellation') = 0,
 'ALTER TABLE tbl_consultations ADD COLUMN dispense_cancellation TEXT NULL', 'SELECT 1');
PREPARE dispense_cancel_stmt FROM @dispense_cancel_ddl;
EXECUTE dispense_cancel_stmt;
DEALLOCATE PREPARE dispense_cancel_stmt;
