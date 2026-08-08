ALTER TABLE tbl_appointments
  ADD COLUMN live_queue_assigned_position INT UNSIGNED NULL AFTER arrival_sequence,
  ADD COLUMN live_queue_displacement_count TINYINT UNSIGNED NOT NULL DEFAULT 0 AFTER live_queue_assigned_position,
  ADD COLUMN live_queue_early_arrival TINYINT(1) NOT NULL DEFAULT 0 AFTER live_queue_displacement_count,
  ADD KEY idx_tbl_appointments_live_assignment (
    fk_branch_id,
    fk_slot_id,
    appointment_date,
    is_active,
    live_queue_assigned_position
  );
