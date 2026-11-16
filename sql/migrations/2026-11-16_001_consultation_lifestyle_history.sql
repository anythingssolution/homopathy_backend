-- migration: retry-safe
-- Nullable structured answers. Legacy free-text history is intentionally untouched.
-- Metadata-guarded DDL, compatible with MySQL and MariaDB.
SET @lifestyle_history_exists = (
    SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'tbl_consultations' AND COLUMN_NAME = 'lifestyle_history'
);
SET @lifestyle_history_ddl = IF(
    @lifestyle_history_exists = 0,
    'ALTER TABLE tbl_consultations ADD COLUMN lifestyle_history TEXT NULL',
    'SELECT 1'
);
PREPARE lifestyle_history_statement FROM @lifestyle_history_ddl;
EXECUTE lifestyle_history_statement;
DEALLOCATE PREPARE lifestyle_history_statement;
