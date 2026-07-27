ALTER TABLE tbl_appointments
  DROP INDEX uq_appointment_patient_branch_slot_date_active,
  ADD UNIQUE KEY uq_appointment_patient_date_active (fk_patient_id, appointment_date, is_active);
