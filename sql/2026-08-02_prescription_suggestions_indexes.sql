-- Performance optimization for Previous Prescription Suggestions feature
ALTER TABLE `tbl_consultations` ADD INDEX `idx_consultations_symptoms` (`symptoms`(255));
ALTER TABLE `tbl_consultations` ADD INDEX `idx_consultations_diagnosis` (`diagnosis`(255));
