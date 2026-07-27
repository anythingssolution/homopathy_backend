CREATE TABLE IF NOT EXISTS `tbl_branch_doctor_leaves` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `doctor_id` BIGINT UNSIGNED NOT NULL,
  `fk_branch_id` BIGINT UNSIGNED NOT NULL,
  `leave_date` DATE NOT NULL,
  `leave_reason` VARCHAR(255) NULL DEFAULT NULL,
  `status` ENUM('ACTIVE', 'CANCELLED') NOT NULL DEFAULT 'ACTIVE',
  `cancelled_at` DATETIME NULL DEFAULT NULL,
  `cancelled_by_user_id` BIGINT UNSIGNED NULL DEFAULT NULL,
  `cancelled_by_role` VARCHAR(20) NULL DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `created_by` BIGINT UNSIGNED NULL DEFAULT NULL,
  `updated_by` BIGINT UNSIGNED NULL DEFAULT NULL,
  `created_ip` VARCHAR(45) NOT NULL,
  `updated_ip` VARCHAR(45) NULL DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_branch_doctor_leave_date` (`doctor_id`, `fk_branch_id`, `leave_date`),
  KEY `idx_branch_doctor_leaves_branch_date_status` (`fk_branch_id`, `leave_date`, `status`),
  KEY `idx_branch_doctor_leaves_doctor_status` (`doctor_id`, `status`),
  KEY `idx_branch_doctor_leaves_cancelled_by` (`cancelled_by_user_id`),
  CONSTRAINT `fk_branch_doctor_leaves_doctor`
    FOREIGN KEY (`doctor_id`) REFERENCES `master_users` (`id`),
  CONSTRAINT `fk_branch_doctor_leaves_branch`
    FOREIGN KEY (`fk_branch_id`) REFERENCES `master_clinic_branches` (`id`),
  CONSTRAINT `fk_branch_doctor_leaves_created_by`
    FOREIGN KEY (`created_by`) REFERENCES `master_users` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_branch_doctor_leaves_updated_by`
    FOREIGN KEY (`updated_by`) REFERENCES `master_users` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_branch_doctor_leaves_cancelled_by`
    FOREIGN KEY (`cancelled_by_user_id`) REFERENCES `master_users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
