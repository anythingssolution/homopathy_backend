-- MySQL does not support a conditional ADD COLUMN clause in this form.
-- The same INFORMATION_SCHEMA guard as the other managed migrations keeps
-- this remains safe when an existing database already has either column.
SET @is_repeat_exists = (
  SELECT COUNT(*)
  FROM `information_schema`.`COLUMNS`
  WHERE `TABLE_SCHEMA` = DATABASE()
    AND `TABLE_NAME` = 'tbl_consultations'
    AND `COLUMN_NAME` = 'is_repeat'
);
SET @is_repeat_ddl = IF(
  @is_repeat_exists = 0,
  'ALTER TABLE `tbl_consultations` ADD COLUMN `is_repeat` TINYINT(1) NOT NULL DEFAULT 0 AFTER `repeated_from_consultation_id`',
  'SELECT 1'
);
PREPARE is_repeat_statement FROM @is_repeat_ddl;
EXECUTE is_repeat_statement;
DEALLOCATE PREPARE is_repeat_statement;

SET @is_same_exists = (
  SELECT COUNT(*)
  FROM `information_schema`.`COLUMNS`
  WHERE `TABLE_SCHEMA` = DATABASE()
    AND `TABLE_NAME` = 'tbl_consultations'
    AND `COLUMN_NAME` = 'is_same'
);
SET @is_same_ddl = IF(
  @is_same_exists = 0,
  'ALTER TABLE `tbl_consultations` ADD COLUMN `is_same` TINYINT(1) NOT NULL DEFAULT 0 AFTER `is_repeat`',
  'SELECT 1'
);
PREPARE is_same_statement FROM @is_same_ddl;
EXECUTE is_same_statement;
DEALLOCATE PREPARE is_same_statement;

ALTER TABLE tbl_consultations
  MODIFY medication_duration_days SMALLINT UNSIGNED NOT NULL;
