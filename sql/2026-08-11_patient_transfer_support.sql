-- Database Migration Script for Patient Transfer Module
-- Adds transferred_from_patient_id column to tbl_appointments for transfer history/auditing.

ALTER TABLE `tbl_appointments`
  ADD COLUMN IF NOT EXISTS `transferred_from_patient_id` bigint(20) unsigned DEFAULT NULL AFTER `fk_patient_id`;

ALTER TABLE `tbl_appointments`
  ADD CONSTRAINT `fk_apt_transferred_from` FOREIGN KEY (`transferred_from_patient_id`) REFERENCES `master_users` (`id`) ON DELETE SET NULL ON UPDATE CASCADE;
