-- Manual query for doctor register / clinic-facing patient number.
-- Run this once before using the updated Previous Patients form.

ALTER TABLE `master_users`
  ADD COLUMN `clinic_patient_no` VARCHAR(50) NULL AFTER `uuid`;

ALTER TABLE `master_users`
  ADD KEY `idx_master_users_clinic_patient_no` (`clinic_patient_no`);
