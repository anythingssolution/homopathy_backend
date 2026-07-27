ALTER TABLE master_slots
  ADD COLUMN default_consult_minutes INT NOT NULL DEFAULT 15 AFTER end_time;

ALTER TABLE tbl_appointments
  ADD COLUMN queue_status ENUM('BOOKED','CHECKED_IN','WAITING','IN_PROGRESS','COMPLETED','CANCELLED','NO_SHOW','SKIPPED') NOT NULL DEFAULT 'BOOKED' AFTER status,
  ADD COLUMN planned_start_at DATETIME NULL AFTER queue_status,
  ADD COLUMN planned_end_at DATETIME NULL AFTER planned_start_at,
  ADD COLUMN actual_called_at DATETIME NULL AFTER planned_end_at,
  ADD COLUMN actual_started_at DATETIME NULL AFTER actual_called_at,
  ADD COLUMN actual_completed_at DATETIME NULL AFTER actual_started_at,
  ADD COLUMN last_queue_event_at DATETIME NULL AFTER actual_completed_at,
  ADD KEY idx_tbl_appointments_live_queue (fk_branch_id, fk_slot_id, appointment_date, queue_status, is_active, current_token_number);

UPDATE tbl_appointments
SET queue_status = CASE
    WHEN status = 'Cancelled' OR is_active = 0 THEN 'CANCELLED'
    WHEN status = 'Completed' THEN 'COMPLETED'
    ELSE 'BOOKED'
END
WHERE queue_status IS NULL
   OR queue_status = '';

CREATE TABLE tbl_live_queue_sessions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  fk_branch_id BIGINT UNSIGNED NOT NULL,
  fk_slot_id BIGINT UNSIGNED NOT NULL,
  appointment_date DATE NOT NULL,
  session_status ENUM('NOT_STARTED','RUNNING','COMPLETED','PAUSED') NOT NULL DEFAULT 'NOT_STARTED',
  current_appointment_id BIGINT UNSIGNED NULL,
  current_token_number TINYINT UNSIGNED NULL,
  session_started_at DATETIME NULL,
  session_ended_at DATETIME NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by BIGINT UNSIGNED NULL,
  updated_by BIGINT UNSIGNED NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_live_queue_session_slot_date (fk_branch_id, fk_slot_id, appointment_date),
  KEY idx_live_queue_session_current_appointment (current_appointment_id),
  CONSTRAINT fk_live_queue_session_branch FOREIGN KEY (fk_branch_id) REFERENCES master_clinic_branches (id),
  CONSTRAINT fk_live_queue_session_slot FOREIGN KEY (fk_slot_id) REFERENCES master_slots (id),
  CONSTRAINT fk_live_queue_session_current_appointment FOREIGN KEY (current_appointment_id) REFERENCES tbl_appointments (appointment_id)
);

CREATE TABLE tbl_appointment_queue_events (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  appointment_id BIGINT UNSIGNED NULL,
  fk_branch_id BIGINT UNSIGNED NOT NULL,
  fk_slot_id BIGINT UNSIGNED NOT NULL,
  appointment_date DATE NOT NULL,
  token_number TINYINT UNSIGNED NULL,
  event_type VARCHAR(100) NOT NULL,
  old_queue_status VARCHAR(30) NULL,
  new_queue_status VARCHAR(30) NULL,
  meta_json TEXT NULL,
  created_by BIGINT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_queue_events_lookup (fk_branch_id, fk_slot_id, appointment_date, created_at),
  KEY idx_queue_events_appointment (appointment_id),
  CONSTRAINT fk_queue_events_appointment FOREIGN KEY (appointment_id) REFERENCES tbl_appointments (appointment_id),
  CONSTRAINT fk_queue_events_branch FOREIGN KEY (fk_branch_id) REFERENCES master_clinic_branches (id),
  CONSTRAINT fk_queue_events_slot FOREIGN KEY (fk_slot_id) REFERENCES master_slots (id)
);
