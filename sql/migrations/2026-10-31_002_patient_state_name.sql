-- migration: retry-safe
-- Optional structured state; existing patients remain NULL until supplied.
-- Metadata-guarded DDL supports MySQL as well as MariaDB and manual pre-application.
SET @patient_state_column_exists = (
    SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'master_users' AND COLUMN_NAME = 'state_name'
);
SET @patient_state_ddl = IF(
    @patient_state_column_exists = 0,
    'ALTER TABLE master_users ADD COLUMN state_name VARCHAR(100) NULL DEFAULT NULL AFTER city',
    'SELECT 1'
);
PREPARE patient_state_statement FROM @patient_state_ddl;
EXECUTE patient_state_statement;
DEALLOCATE PREPARE patient_state_statement;
