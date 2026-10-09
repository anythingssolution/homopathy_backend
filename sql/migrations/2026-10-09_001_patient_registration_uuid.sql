-- migration: retry-safe
-- Registration numbers are now stored only in master_users.uuid.
SET @registration_column_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'master_users' AND COLUMN_NAME = 'clinic_patient_no');
SET @registration_cleanup_sql = IF(@registration_column_exists > 0,
  'ALTER TABLE master_users DROP COLUMN clinic_patient_no', 'SELECT 1');
PREPARE registration_cleanup FROM @registration_cleanup_sql;
EXECUTE registration_cleanup;
DEALLOCATE PREPARE registration_cleanup;

UPDATE master_users
SET full_name = CONCAT('Patient ', uuid)
WHERE role = 'PAT' AND full_name = CONCAT('Previous Patient ', uuid);
