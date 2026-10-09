-- migration: retry-safe
-- migration: compatible-checksum d55024d5f344790c5ff7c16f4dece75b4246ee49e8dcc4771fcd963519cda95f
-- Portable recovery of the original MariaDB-specific ALTER syntax.
-- Inspect metadata and apply the required clauses in one ALTER TABLE so
-- active token uniqueness remains protected throughout the index transition.
SET @appointment_alter_clauses = '';

SET @appointment_object_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tbl_appointments' AND COLUMN_NAME = 'active_token_booking_key');
SET @appointment_alter_clauses = CONCAT_WS(', ', NULLIF(@appointment_alter_clauses, ''),
  IF(@appointment_object_exists = 0, 'ADD COLUMN `active_token_booking_key` VARCHAR(120)
    GENERATED ALWAYS AS (
      CASE
        WHEN `is_active` = 1
          AND `status` <> ''Cancelled''
          AND COALESCE(`reception_status`, '''') <> ''REJECTED_BY_RECEPTION''
          AND COALESCE(`queue_status`, '''') <> ''CANCELLED''
        THEN CONCAT(
          `fk_branch_id`, '':'',
          `fk_slot_id`, '':'',
          `appointment_date`, '':'',
          `token_number`
        )
        ELSE NULL
      END
    ) STORED', NULL));

SET @appointment_object_exists = (SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tbl_appointments' AND INDEX_NAME = 'uq_appointment_active_token_booking');
SET @appointment_alter_clauses = CONCAT_WS(', ', NULLIF(@appointment_alter_clauses, ''),
  IF(@appointment_object_exists = 0, 'ADD UNIQUE INDEX `uq_appointment_active_token_booking` (`active_token_booking_key`)', NULL));

SET @appointment_object_exists = (SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tbl_appointments' AND INDEX_NAME = 'idx_appointment_booking_subject_date_active');
SET @appointment_alter_clauses = CONCAT_WS(', ', NULLIF(@appointment_alter_clauses, ''),
  IF(@appointment_object_exists = 0, 'ADD INDEX `idx_appointment_booking_subject_date_active` (`booking_subject_key`, `appointment_date`, `is_active`)', NULL));

SET @appointment_object_exists = (SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tbl_appointments' AND INDEX_NAME = 'uq_appointment_branch_slot_date_token_active');
SET @appointment_alter_clauses = CONCAT_WS(', ', NULLIF(@appointment_alter_clauses, ''),
  IF(@appointment_object_exists > 0, 'DROP INDEX `uq_appointment_branch_slot_date_token_active`', NULL));

SET @appointment_object_exists = (SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tbl_appointments' AND INDEX_NAME = 'uq_appointment_booking_subject_date_active');
SET @appointment_alter_clauses = CONCAT_WS(', ', NULLIF(@appointment_alter_clauses, ''),
  IF(@appointment_object_exists > 0, 'DROP INDEX `uq_appointment_booking_subject_date_active`', NULL));

SET @appointment_object_exists = (SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tbl_appointments' AND INDEX_NAME = 'uq_appointment_patient_branch_slot_date_active');
SET @appointment_alter_clauses = CONCAT_WS(', ', NULLIF(@appointment_alter_clauses, ''),
  IF(@appointment_object_exists > 0, 'DROP INDEX `uq_appointment_patient_branch_slot_date_active`', NULL));

SET @appointment_object_exists = (SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tbl_appointments' AND INDEX_NAME = 'uq_appointment_patient_date_active');
SET @appointment_alter_clauses = CONCAT_WS(', ', NULLIF(@appointment_alter_clauses, ''),
  IF(@appointment_object_exists > 0, 'DROP INDEX `uq_appointment_patient_date_active`', NULL));

SET @appointment_object_exists = (SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tbl_appointments' AND INDEX_NAME = 'uq_appointment_active_subject_date');
SET @appointment_alter_clauses = CONCAT_WS(', ', NULLIF(@appointment_alter_clauses, ''),
  IF(@appointment_object_exists > 0, 'DROP INDEX `uq_appointment_active_subject_date`', NULL));

SET @appointment_object_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tbl_appointments' AND COLUMN_NAME = 'active_booking_subject_date_key');
SET @appointment_alter_clauses = CONCAT_WS(', ', NULLIF(@appointment_alter_clauses, ''),
  IF(@appointment_object_exists > 0, 'DROP COLUMN `active_booking_subject_date_key`', NULL));

SET @appointment_alter_sql = IF(@appointment_alter_clauses = '', 'SELECT 1',
  CONCAT('ALTER TABLE `tbl_appointments` ', @appointment_alter_clauses));
PREPARE appointment_cancellation_fix FROM @appointment_alter_sql;
EXECUTE appointment_cancellation_fix;
DEALLOCATE PREPARE appointment_cancellation_fix;
