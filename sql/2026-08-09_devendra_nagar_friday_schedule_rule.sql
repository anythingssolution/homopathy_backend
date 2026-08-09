-- Migration: Configure Friday schedule rule for Branch 2 (Devendra Nagar / Pandri Branch)
-- Requirement: For Devendra Nagar location Pandri Branch (branch_id = 2), every Friday, the first available slot starts at 3:00 PM (15:00:00).

-- 1. Create table for recurring branch slot schedule rules (day-of-week rules)
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
  CONSTRAINT `fk_recurring_rule_branch` FOREIGN KEY (`fk_branch_id`) REFERENCES `master_clinic_branches` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 2. Insert/Update recurring rule for Branch 2 (Devendra Nagar / Pandri Branch) on Fridays (day_of_week = 6, 3:00 PM = 15:00:00)
INSERT INTO `tbl_branch_recurring_schedule_rules`
  (`fk_branch_id`, `fk_slot_id`, `day_of_week`, `override_start_time`, `rule_description`, `is_active`)
VALUES
  (2, NULL, 6, '15:00:00', 'Devendra Nagar (Pandri Branch) Friday first slot starts at 3:00 PM', 1)
ON DUPLICATE KEY UPDATE
  `override_start_time` = VALUES(`override_start_time`),
  `rule_description` = VALUES(`rule_description`),
  `is_active` = 1,
  `updated_at` = CURRENT_TIMESTAMP;

-- 3. Add column to master_slots if not present for direct fallback
ALTER TABLE `master_slots`
  ADD COLUMN IF NOT EXISTS `friday_start_time` TIME NULL AFTER `end_time`;

-- 4. Update the first slot for branch 2 to have friday_start_time = 15:00:00
UPDATE `master_slots`
SET `friday_start_time` = '15:00:00'
WHERE `fk_branch_id` = 2
  AND `is_active` = 1
ORDER BY `start_time` ASC
LIMIT 1;
