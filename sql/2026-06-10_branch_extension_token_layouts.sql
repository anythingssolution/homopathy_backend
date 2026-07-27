CREATE TABLE IF NOT EXISTS `tbl_branch_extension_token_layouts` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `fk_branch_id` BIGINT UNSIGNED NOT NULL,
  `sequence_number` SMALLINT UNSIGNED NOT NULL,
  `treatment_code` VARCHAR(50) NOT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_branch_extension_sequence` (`fk_branch_id`, `sequence_number`),
  CONSTRAINT `fk_branch_extension_layout_branch`
    FOREIGN KEY (`fk_branch_id`) REFERENCES `master_clinic_branches` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
