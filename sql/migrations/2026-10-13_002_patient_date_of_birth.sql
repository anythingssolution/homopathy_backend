-- migration: retry-safe

SET @patient_dob_alter_clauses = '';

SET @patient_dob_object_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'master_users' AND COLUMN_NAME = 'date_of_birth');
SET @patient_dob_alter_clauses = CONCAT_WS(', ', NULLIF(@patient_dob_alter_clauses, ''),
  IF(@patient_dob_object_exists = 0, 'ADD COLUMN `date_of_birth` DATE NULL AFTER `age`', NULL));

SET @patient_dob_alter_sql = IF(@patient_dob_alter_clauses = '', 'SELECT 1',
  CONCAT('ALTER TABLE `master_users` ', @patient_dob_alter_clauses));
PREPARE patient_dob_migration FROM @patient_dob_alter_sql;
EXECUTE patient_dob_migration;
DEALLOCATE PREPARE patient_dob_migration;

SET @family_dob_alter_clauses = '';

SET @family_dob_object_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tbl_patient_family_members' AND COLUMN_NAME = 'date_of_birth');
SET @family_dob_alter_clauses = CONCAT_WS(', ', NULLIF(@family_dob_alter_clauses, ''),
  IF(@family_dob_object_exists = 0, 'ADD COLUMN `date_of_birth` DATE NULL AFTER `age`', NULL));

SET @family_dob_alter_sql = IF(@family_dob_alter_clauses = '', 'SELECT 1',
  CONCAT('ALTER TABLE `tbl_patient_family_members` ', @family_dob_alter_clauses));
PREPARE family_dob_migration FROM @family_dob_alter_sql;
EXECUTE family_dob_migration;
DEALLOCATE PREPARE family_dob_migration;
