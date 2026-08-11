-- Managed migration: configure the Branch 2 Friday first-slot start time.
-- Safe whether the legacy 2026-08-09 script was already run manually or not.

CREATE TABLE IF NOT EXISTS `tbl_branch_recurring_schedule_rules` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `fk_branch_id` bigint(20) unsigned NOT NULL,
  `fk_slot_id` bigint(20) unsigned DEFAULT NULL COMMENT 'NULL applies to the first available slot for the branch',
  `day_of_week` tinyint(1) NOT NULL COMMENT '1=Sunday, 2=Monday, 3=Tuesday, 4=Wednesday, 5=Thursday, 6=Friday, 7=Saturday',
  `override_start_time` time NOT NULL,
  `override_end_time` time DEFAULT NULL,
  `rule_description` varchar(255) DEFAULT NULL,
  `is_active` tinyint(1) NOT NULL DEFAULT 1,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_branch_day` (`fk_branch_id`, `day_of_week`, `is_active`),
  CONSTRAINT `fk_recurring_rule_branch` FOREIGN KEY (`fk_branch_id`)
    REFERENCES `master_clinic_branches` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

SET @friday_column_exists = (
  SELECT COUNT(*)
  FROM `information_schema`.`COLUMNS`
  WHERE `TABLE_SCHEMA` = DATABASE()
    AND `TABLE_NAME` = 'master_slots'
    AND `COLUMN_NAME` = 'friday_start_time'
);
SET @friday_column_ddl = IF(
  @friday_column_exists = 0,
  'ALTER TABLE `master_slots` ADD COLUMN `friday_start_time` TIME NULL AFTER `end_time`',
  'SELECT 1'
);
PREPARE friday_column_statement FROM @friday_column_ddl;
EXECUTE friday_column_statement;
DEALLOCATE PREPARE friday_column_statement;

DELETE duplicate_rule
FROM `tbl_branch_recurring_schedule_rules` AS duplicate_rule
INNER JOIN `tbl_branch_recurring_schedule_rules` AS keeper
  ON keeper.`fk_branch_id` = duplicate_rule.`fk_branch_id`
  AND keeper.`day_of_week` = duplicate_rule.`day_of_week`
  AND keeper.`fk_slot_id` IS NULL
  AND duplicate_rule.`fk_slot_id` IS NULL
  AND keeper.`id` < duplicate_rule.`id`
WHERE duplicate_rule.`fk_branch_id` = 2
  AND duplicate_rule.`day_of_week` = 6;

UPDATE `tbl_branch_recurring_schedule_rules`
SET `override_start_time` = '15:00:00',
    `rule_description` = 'Devendra Nagar (Pandri Branch) Friday first slot starts at 3:00 PM',
    `is_active` = 1,
    `updated_at` = CURRENT_TIMESTAMP
WHERE `fk_branch_id` = 2
  AND `fk_slot_id` IS NULL
  AND `day_of_week` = 6;

INSERT INTO `tbl_branch_recurring_schedule_rules`
  (`fk_branch_id`, `fk_slot_id`, `day_of_week`, `override_start_time`, `rule_description`, `is_active`)
SELECT
  2,
  NULL,
  6,
  '15:00:00',
  'Devendra Nagar (Pandri Branch) Friday first slot starts at 3:00 PM',
  1
WHERE NOT EXISTS (
  SELECT 1
  FROM `tbl_branch_recurring_schedule_rules`
  WHERE `fk_branch_id` = 2
    AND `fk_slot_id` IS NULL
    AND `day_of_week` = 6
);

UPDATE `master_slots`
SET `friday_start_time` = '15:00:00'
WHERE `fk_branch_id` = 2
  AND `is_active` = 1
ORDER BY `start_time` ASC
LIMIT 1;
