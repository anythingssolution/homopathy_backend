-- Manual query for structured patient address fields used by public registration.
-- ward_no and vidhan_sabha already exist in some databases from 2026-07-29_patient_history_records.sql.

ALTER TABLE `master_users`
  ADD COLUMN `area_name` VARCHAR(150) NULL AFTER `address`,
  ADD COLUMN `pincode` VARCHAR(10) NULL AFTER `ward_no`,
  ADD COLUMN `city` VARCHAR(100) NULL AFTER `pincode`;

ALTER TABLE `master_users`
  ADD KEY `idx_master_users_area_name` (`area_name`),
  ADD KEY `idx_master_users_pincode` (`pincode`),
  ADD KEY `idx_master_users_city` (`city`);
