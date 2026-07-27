ALTER TABLE tbl_appointments
  ADD COLUMN assigned_visit_type_code VARCHAR(50) NULL AFTER fk_treatment_id,
  ADD COLUMN assigned_slot_duration_minutes SMALLINT UNSIGNED NULL AFTER assigned_visit_type_code;
