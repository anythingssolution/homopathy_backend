ALTER TABLE `tbl_slot_token_extensions`
  DROP INDEX IF EXISTS `uq_active_slot_token_extension`;

ALTER TABLE `tbl_slot_token_extensions`
  DROP COLUMN IF EXISTS `active_context_key`;

ALTER TABLE `tbl_slot_token_extensions`
  ADD COLUMN IF NOT EXISTS `block_number` TINYINT UNSIGNED NULL AFTER `appointment_date`;

SET @extension_context := '';
SET @extension_block := 0;

UPDATE `tbl_slot_token_extensions` e
JOIN (
  SELECT
    id,
    (@extension_block := IF(
      @extension_context = CONCAT(fk_branch_id, ':', fk_slot_id, ':', appointment_date),
      @extension_block + 1,
      1
    )) AS calculated_block,
    (@extension_context := CONCAT(fk_branch_id, ':', fk_slot_id, ':', appointment_date)) AS context_key
  FROM `tbl_slot_token_extensions`
  CROSS JOIN (SELECT @extension_context := '', @extension_block := 0) vars
  ORDER BY fk_branch_id, fk_slot_id, appointment_date, created_at, id
) numbered ON numbered.id = e.id
SET e.block_number = numbered.calculated_block
WHERE e.block_number IS NULL;

ALTER TABLE `tbl_slot_token_extensions`
  MODIFY COLUMN `block_number` TINYINT UNSIGNED NOT NULL;

ALTER TABLE `tbl_slot_token_extensions`
  ADD COLUMN IF NOT EXISTS `active_context_key` VARCHAR(120)
    GENERATED ALWAYS AS (
      CASE
        WHEN `status` = 'ACTIVE'
        THEN CONCAT(
          `fk_branch_id`, ':', `fk_slot_id`, ':', `appointment_date`, ':', `block_number`
        )
        ELSE NULL
      END
    ) STORED;

CREATE UNIQUE INDEX IF NOT EXISTS `uq_active_slot_token_extension`
  ON `tbl_slot_token_extensions` (`active_context_key`);

CREATE INDEX IF NOT EXISTS `idx_slot_extension_block`
  ON `tbl_slot_token_extensions`
  (`fk_branch_id`, `fk_slot_id`, `appointment_date`, `block_number`, `status`);
