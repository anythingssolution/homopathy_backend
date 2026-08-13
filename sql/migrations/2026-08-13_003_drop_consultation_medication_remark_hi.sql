-- Drop unused remark_hi; Hindi text is stored in the existing remark column.

SET @remark_hi_exists = (
  SELECT COUNT(*)
  FROM `information_schema`.`COLUMNS`
  WHERE `TABLE_SCHEMA` = DATABASE()
    AND `TABLE_NAME` = 'tbl_consultation_medications'
    AND `COLUMN_NAME` = 'remark_hi'
);
SET @remark_hi_ddl = IF(
  @remark_hi_exists > 0,
  'ALTER TABLE `tbl_consultation_medications` DROP COLUMN `remark_hi`',
  'SELECT 1'
);
PREPARE remark_hi_drop_statement FROM @remark_hi_ddl;
EXECUTE remark_hi_drop_statement;
DEALLOCATE PREPARE remark_hi_drop_statement;
