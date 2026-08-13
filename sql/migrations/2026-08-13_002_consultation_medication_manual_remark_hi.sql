-- Manual other-medication entry tracking + Hindi remark storage.

SET @remark_hi_exists = (
  SELECT COUNT(*)
  FROM `information_schema`.`COLUMNS`
  WHERE `TABLE_SCHEMA` = DATABASE()
    AND `TABLE_NAME` = 'tbl_consultation_medications'
    AND `COLUMN_NAME` = 'remark_hi'
);
SET @remark_hi_ddl = IF(
  @remark_hi_exists = 0,
  'ALTER TABLE `tbl_consultation_medications` ADD COLUMN `remark_hi` VARCHAR(255) NULL AFTER `remark`',
  'SELECT 1'
);
PREPARE remark_hi_statement FROM @remark_hi_ddl;
EXECUTE remark_hi_statement;
DEALLOCATE PREPARE remark_hi_statement;

SET @manual_entry_exists = (
  SELECT COUNT(*)
  FROM `information_schema`.`COLUMNS`
  WHERE `TABLE_SCHEMA` = DATABASE()
    AND `TABLE_NAME` = 'tbl_consultation_medications'
    AND `COLUMN_NAME` = 'is_manual_entry'
);
SET @manual_entry_ddl = IF(
  @manual_entry_exists = 0,
  'ALTER TABLE `tbl_consultation_medications` ADD COLUMN `is_manual_entry` TINYINT(1) NOT NULL DEFAULT 0 AFTER `remark_hi`',
  'SELECT 1'
);
PREPARE manual_entry_statement FROM @manual_entry_ddl;
EXECUTE manual_entry_statement;
DEALLOCATE PREPARE manual_entry_statement;
