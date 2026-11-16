-- migration: retry-safe
-- Doctor-specific preference; OFF preserves existing consultation behavior.
-- Compatible prepared DDL for MySQL/MariaDB; no existing user data is rewritten.
SET @consultation_autofill_ddl = (
    SELECT IF(COUNT(*) = 0,
        'ALTER TABLE master_users ADD COLUMN consultation_autofill_enabled TINYINT(1) NOT NULL DEFAULT 0',
        'SELECT 1')
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'master_users'
      AND COLUMN_NAME = 'consultation_autofill_enabled'
);
PREPARE consultation_autofill_statement FROM @consultation_autofill_ddl;
EXECUTE consultation_autofill_statement;
DEALLOCATE PREPARE consultation_autofill_statement;
