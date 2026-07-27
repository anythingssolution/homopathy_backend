CREATE TABLE IF NOT EXISTS `tbl_consultation_tests` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `consultation_id` BIGINT UNSIGNED NOT NULL,
  `test_name` VARCHAR(255) NOT NULL,
  `amount` DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_consultation_tests_consultation` (`consultation_id`),
  CONSTRAINT `fk_consultation_tests_consultation`
    FOREIGN KEY (`consultation_id`) REFERENCES `tbl_consultations` (`id`)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
