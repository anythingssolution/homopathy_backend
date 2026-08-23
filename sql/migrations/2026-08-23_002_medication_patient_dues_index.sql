-- Speeds up patient outstanding / borrowed-medication lookups used by
-- dispensary lists, repeat medicine, billing dues APIs, and reports.

SET @dues_index_exists = (
  SELECT COUNT(*)
  FROM `information_schema`.`STATISTICS`
  WHERE `TABLE_SCHEMA` = DATABASE()
    AND `TABLE_NAME` = 'tbl_bills'
    AND `INDEX_NAME` = 'idx_tbl_bills_patient_medication_pending'
);

SET @dues_index_ddl = IF(
  @dues_index_exists = 0,
  'ALTER TABLE `tbl_bills` ADD KEY `idx_tbl_bills_patient_medication_pending` (`patient_id`, `status`, `bill_type`, `pending_amount`)',
  'SELECT 1'
);

PREPARE dues_index_statement FROM @dues_index_ddl;
EXECUTE dues_index_statement;
DEALLOCATE PREPARE dues_index_statement;
