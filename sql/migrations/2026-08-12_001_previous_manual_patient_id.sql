-- Add manually entered patient ID for legacy / previous-patient records.

SET @patient_id_column_exists = (
  SELECT COUNT(*)
  FROM `information_schema`.`COLUMNS`
  WHERE `TABLE_SCHEMA` = DATABASE()
    AND `TABLE_NAME` = 'tbl_previous_manual_patients'
    AND `COLUMN_NAME` = 'patient_id'
);
SET @patient_id_column_ddl = IF(
  @patient_id_column_exists = 0,
  'ALTER TABLE `tbl_previous_manual_patients` ADD COLUMN `patient_id` VARCHAR(50) NULL AFTER `full_name`',
  'SELECT 1'
);
PREPARE patient_id_column_statement FROM @patient_id_column_ddl;
EXECUTE patient_id_column_statement;
DEALLOCATE PREPARE patient_id_column_statement;

SET @patient_id_index_exists = (
  SELECT COUNT(*)
  FROM `information_schema`.`STATISTICS`
  WHERE `TABLE_SCHEMA` = DATABASE()
    AND `TABLE_NAME` = 'tbl_previous_manual_patients'
    AND `INDEX_NAME` = 'uk_previous_manual_patients_patient_id'
);
SET @patient_id_index_ddl = IF(
  @patient_id_index_exists = 0,
  'ALTER TABLE `tbl_previous_manual_patients` ADD UNIQUE KEY `uk_previous_manual_patients_patient_id` (`patient_id`)',
  'SELECT 1'
);
PREPARE patient_id_index_statement FROM @patient_id_index_ddl;
EXECUTE patient_id_index_statement;
DEALLOCATE PREPARE patient_id_index_statement;
