ALTER TABLE tbl_appointments
  ADD COLUMN checked_in_at DATETIME NULL AFTER last_queue_event_at,
  ADD COLUMN arrival_sequence INT UNSIGNED NULL AFTER checked_in_at,
  ADD KEY idx_tbl_appointments_live_ready (fk_branch_id, fk_slot_id, appointment_date, is_active, queue_status, current_token_number, arrival_sequence, checked_in_at);

UPDATE tbl_appointments
SET checked_in_at = COALESCE(
        checked_in_at,
        actual_started_at,
        actual_called_at,
        last_queue_event_at
    )
WHERE is_active = 1
  AND queue_status IN ('CHECKED_IN', 'WAITING', 'IN_PROGRESS')
  AND checked_in_at IS NULL;

UPDATE tbl_appointments
SET arrival_sequence = current_token_number
WHERE is_active = 1
  AND queue_status IN ('CHECKED_IN', 'WAITING', 'IN_PROGRESS')
  AND checked_in_at IS NOT NULL
  AND arrival_sequence IS NULL;
