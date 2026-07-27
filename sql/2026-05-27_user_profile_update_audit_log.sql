CREATE TABLE IF NOT EXISTS `log_user_profile_updates` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id` BIGINT UNSIGNED NOT NULL,
  `changed_by_user_id` BIGINT UNSIGNED NULL,
  `changed_by_role` VARCHAR(20) NULL,
  `ip_address` VARCHAR(64) NULL,
  `user_agent` VARCHAR(255) NULL,
  `changed_fields_json` JSON NOT NULL,
  `old_values_json` JSON NOT NULL,
  `new_values_json` JSON NOT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_log_user_profile_updates_user` (`user_id`),
  KEY `idx_log_user_profile_updates_actor` (`changed_by_user_id`),
  KEY `idx_log_user_profile_updates_created_at` (`created_at`),
  CONSTRAINT `fk_log_user_profile_updates_user`
    FOREIGN KEY (`user_id`) REFERENCES `master_users` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_log_user_profile_updates_actor`
    FOREIGN KEY (`changed_by_user_id`) REFERENCES `master_users` (`id`)
    ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
