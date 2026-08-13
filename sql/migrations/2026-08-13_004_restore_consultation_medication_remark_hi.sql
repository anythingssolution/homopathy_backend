-- Restore remark_hi for bilingual prescription remarks.
-- English stays in `remark`; Hindi translation is stored in `remark_hi`.

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
PREPARE remark_hi_add_statement FROM @remark_hi_ddl;
EXECUTE remark_hi_add_statement;
DEALLOCATE PREPARE remark_hi_add_statement;
