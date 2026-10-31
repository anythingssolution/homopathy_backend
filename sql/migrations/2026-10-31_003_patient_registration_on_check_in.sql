-- migration: retry-safe
-- Preserve all assigned numbers and their unique index. Only future unregistered
-- patients may have NULL; multiple NULL values are supported by MySQL/MariaDB.
SET @patient_uuid_ddl = (
    SELECT IF(IS_NULLABLE = 'NO', CONCAT(
        'ALTER TABLE master_users MODIFY COLUMN uuid ', COLUMN_TYPE,
        ' CHARACTER SET ', CHARACTER_SET_NAME, ' COLLATE ', COLLATION_NAME,
        ' NULL DEFAULT NULL'
    ), 'SELECT 1')
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'master_users' AND COLUMN_NAME = 'uuid'
);
PREPARE patient_uuid_statement FROM @patient_uuid_ddl;
EXECUTE patient_uuid_statement;
DEALLOCATE PREPARE patient_uuid_statement;

CREATE TABLE IF NOT EXISTS tbl_patient_registration_sequence (
    id TINYINT UNSIGNED NOT NULL PRIMARY KEY,
    last_serial BIGINT UNSIGNED NOT NULL
) ENGINE=InnoDB;

INSERT INTO tbl_patient_registration_sequence (id, last_serial)
SELECT 1, GREATEST(COALESCE(MAX(CAST(SUBSTRING(REPLACE(uuid, '_', ''), 4) AS UNSIGNED)), 0), 9989)
FROM master_users WHERE uuid REGEXP '^DTH_?[0-9]+$'
ON DUPLICATE KEY UPDATE last_serial = GREATEST(last_serial, VALUES(last_serial));
