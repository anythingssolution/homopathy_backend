ALTER TABLE `tbl_doctor_live_sessions`
  ADD COLUMN `fk_slot_id` BIGINT UNSIGNED NULL DEFAULT NULL AFTER `fk_branch_id`,
  ADD KEY `idx_doctor_live_sessions_slot` (`fk_slot_id`),
  ADD CONSTRAINT `fk_doctor_live_sessions_slot`
    FOREIGN KEY (`fk_slot_id`) REFERENCES `master_slots` (`id`);
