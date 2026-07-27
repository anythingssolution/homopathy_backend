ALTER TABLE `tbl_consultations`
  ADD COLUMN IF NOT EXISTS `follow_up_after_days` SMALLINT UNSIGNED NOT NULL DEFAULT 15
    AFTER `follow_up_chain_closed`,
  ADD COLUMN IF NOT EXISTS `repeated_from_consultation_id` BIGINT UNSIGNED NULL
    AFTER `follow_up_after_days`;

CREATE INDEX IF NOT EXISTS `idx_consultations_repeated_from`
  ON `tbl_consultations` (`repeated_from_consultation_id`);
