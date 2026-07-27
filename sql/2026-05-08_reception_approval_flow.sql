ALTER TABLE tbl_appointments
  ADD COLUMN IF NOT EXISTS reception_status VARCHAR(50) NOT NULL DEFAULT 'PENDING_AT_RECEPTION' AFTER status,
  ADD COLUMN IF NOT EXISTS reception_approved_at TIMESTAMP NULL DEFAULT NULL AFTER reception_status,
  ADD COLUMN IF NOT EXISTS reception_approved_by BIGINT UNSIGNED NULL AFTER reception_approved_at,
  ADD COLUMN IF NOT EXISTS reception_rejected_at TIMESTAMP NULL DEFAULT NULL AFTER reception_approved_by,
  ADD COLUMN IF NOT EXISTS reception_rejected_by BIGINT UNSIGNED NULL AFTER reception_rejected_at,
  ADD COLUMN IF NOT EXISTS reception_rejection_reason VARCHAR(255) NULL AFTER reception_rejected_by,
  ADD CONSTRAINT fk_tbl_appointments_reception_approved_by
    FOREIGN KEY (reception_approved_by) REFERENCES master_users (id),
  ADD CONSTRAINT fk_tbl_appointments_reception_rejected_by
    FOREIGN KEY (reception_rejected_by) REFERENCES master_users (id);

CREATE INDEX idx_tbl_appointments_reception_status
ON tbl_appointments (reception_status, appointment_date, fk_branch_id, fk_slot_id);
