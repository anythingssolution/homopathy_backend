ALTER TABLE `tbl_consultations`
  ADD COLUMN `consultation_mode` ENUM('PHYSICAL_PRESENT', 'ON_CALL') NOT NULL DEFAULT 'PHYSICAL_PRESENT' AFTER `medication_duration_days`,
  ADD COLUMN `oxygen_saturation` VARCHAR(50) NULL AFTER `consultation_mode`,
  ADD COLUMN `blood_pressure` VARCHAR(50) NULL AFTER `oxygen_saturation`,
  ADD COLUMN `patient_height` VARCHAR(50) NULL AFTER `blood_pressure`,
  ADD COLUMN `patient_weight` VARCHAR(50) NULL AFTER `patient_height`;
