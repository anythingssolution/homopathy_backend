ALTER TABLE `tbl_live_queue_sessions`
  ADD COLUMN `runtime_anchor_at` DATETIME NULL AFTER `session_ended_at`,
  ADD COLUMN `last_runtime_recalc_at` DATETIME NULL AFTER `runtime_anchor_at`,
  ADD COLUMN `auto_call_next_due_at` DATETIME NULL AFTER `last_runtime_recalc_at`,
  ADD COLUMN `auto_call_next_reason` VARCHAR(100) NULL AFTER `auto_call_next_due_at`,
  ADD COLUMN `queue_revision` BIGINT NOT NULL DEFAULT 0 AFTER `auto_call_next_reason`,
  ADD KEY `idx_live_queue_sessions_auto_due` (`session_status`, `auto_call_next_due_at`);

ALTER TABLE `tbl_appointments`
  ADD COLUMN `live_estimated_start_at` DATETIME NULL AFTER `planned_end_at`,
  ADD COLUMN `live_estimated_end_at` DATETIME NULL AFTER `live_estimated_start_at`,
  ADD COLUMN `live_wait_minutes_snapshot` INT NULL AFTER `live_estimated_end_at`,
  ADD COLUMN `live_eta_updated_at` DATETIME NULL AFTER `live_wait_minutes_snapshot`,
  ADD KEY `idx_tbl_appointments_live_eta` (`fk_branch_id`, `fk_slot_id`, `appointment_date`, `queue_status`, `live_estimated_start_at`);
