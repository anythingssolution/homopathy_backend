ALTER TABLE tbl_appointments
  ADD COLUMN booked_by_type ENUM('SELF','RECEPTIONIST') NOT NULL DEFAULT 'SELF' AFTER status,
  ADD COLUMN booked_by_user_id BIGINT UNSIGNED NULL AFTER booked_by_type,
  ADD COLUMN original_token_number TINYINT UNSIGNED NULL AFTER token_number,
  ADD COLUMN current_token_number TINYINT UNSIGNED NULL AFTER original_token_number,
  ADD COLUMN is_shifted TINYINT(1) NOT NULL DEFAULT 0 AFTER current_token_number,
  ADD COLUMN shift_reason VARCHAR(255) NULL AFTER is_shifted,
  ADD COLUMN not_available_at TIMESTAMP NULL DEFAULT NULL AFTER shift_reason,
  ADD COLUMN rescheduled_from_appointment_id BIGINT UNSIGNED NULL AFTER not_available_at,
  ADD COLUMN reschedule_reason VARCHAR(255) NULL AFTER rescheduled_from_appointment_id,
  ADD KEY idx_appointment_current_token (fk_branch_id, fk_slot_id, appointment_date, current_token_number, is_active),
  ADD KEY idx_appointment_booked_by_user (booked_by_user_id),
  ADD KEY idx_appointment_rescheduled_from (rescheduled_from_appointment_id),
  ADD CONSTRAINT fk_appointment_booked_by_user
    FOREIGN KEY (booked_by_user_id) REFERENCES master_users (id),
  ADD CONSTRAINT fk_appointment_rescheduled_from
    FOREIGN KEY (rescheduled_from_appointment_id) REFERENCES tbl_appointments (appointment_id);

UPDATE tbl_appointments
SET original_token_number = token_number,
    current_token_number = token_number
WHERE original_token_number IS NULL
   OR current_token_number IS NULL;
