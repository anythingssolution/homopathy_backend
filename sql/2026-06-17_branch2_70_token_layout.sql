-- Branch 2 (Pandri / Devendra Nagar) base OPD plate.
-- Durations remain master-treatment controlled by the application:
-- Acute = 2 min, First Consultation = 10 min, Follow-up = 4.5 min.
-- Branch 1 keeps the existing 40-token layout.

INSERT INTO `tbl_branch_token_layouts`
  (`fk_branch_id`, `token_number`, `visit_type_code`)
VALUES
  (2, 1, 'FOLLOW_UP_VISIT'),
  (2, 2, 'FOLLOW_UP_VISIT'),
  (2, 3, 'FOLLOW_UP_VISIT'),
  (2, 4, 'FOLLOW_UP_VISIT'),
  (2, 5, 'ACUTE_TREATMENT'),
  (2, 6, 'FIRST_CONSULTATION'),
  (2, 7, 'FOLLOW_UP_VISIT'),
  (2, 8, 'FOLLOW_UP_VISIT'),
  (2, 9, 'FOLLOW_UP_VISIT'),
  (2, 10, 'ACUTE_TREATMENT'),
  (2, 11, 'FIRST_CONSULTATION'),
  (2, 12, 'FOLLOW_UP_VISIT'),
  (2, 13, 'FOLLOW_UP_VISIT'),
  (2, 14, 'FOLLOW_UP_VISIT'),
  (2, 15, 'ACUTE_TREATMENT'),
  (2, 16, 'FIRST_CONSULTATION'),
  (2, 17, 'FOLLOW_UP_VISIT'),
  (2, 18, 'FOLLOW_UP_VISIT'),
  (2, 19, 'FOLLOW_UP_VISIT'),
  (2, 20, 'ACUTE_TREATMENT'),
  (2, 21, 'FIRST_CONSULTATION'),
  (2, 22, 'FOLLOW_UP_VISIT'),
  (2, 23, 'FOLLOW_UP_VISIT'),
  (2, 24, 'FOLLOW_UP_VISIT'),
  (2, 25, 'ACUTE_TREATMENT'),
  (2, 26, 'FIRST_CONSULTATION'),
  (2, 27, 'FOLLOW_UP_VISIT'),
  (2, 28, 'FOLLOW_UP_VISIT'),
  (2, 29, 'FOLLOW_UP_VISIT'),
  (2, 30, 'ACUTE_TREATMENT'),
  (2, 31, 'FIRST_CONSULTATION'),
  (2, 32, 'FOLLOW_UP_VISIT'),
  (2, 33, 'FOLLOW_UP_VISIT'),
  (2, 34, 'FOLLOW_UP_VISIT'),
  (2, 35, 'ACUTE_TREATMENT'),
  (2, 36, 'FIRST_CONSULTATION'),
  (2, 37, 'FOLLOW_UP_VISIT'),
  (2, 38, 'FOLLOW_UP_VISIT'),
  (2, 39, 'FOLLOW_UP_VISIT'),
  (2, 40, 'ACUTE_TREATMENT'),
  (2, 41, 'FIRST_CONSULTATION'),
  (2, 42, 'FOLLOW_UP_VISIT'),
  (2, 43, 'FOLLOW_UP_VISIT'),
  (2, 44, 'FOLLOW_UP_VISIT'),
  (2, 45, 'FOLLOW_UP_VISIT'),
  (2, 46, 'FIRST_CONSULTATION'),
  (2, 47, 'FOLLOW_UP_VISIT'),
  (2, 48, 'FOLLOW_UP_VISIT'),
  (2, 49, 'FOLLOW_UP_VISIT'),
  (2, 50, 'FOLLOW_UP_VISIT'),
  (2, 51, 'FIRST_CONSULTATION'),
  (2, 52, 'FOLLOW_UP_VISIT'),
  (2, 53, 'FOLLOW_UP_VISIT'),
  (2, 54, 'FOLLOW_UP_VISIT'),
  (2, 55, 'FOLLOW_UP_VISIT'),
  (2, 56, 'FIRST_CONSULTATION'),
  (2, 57, 'FOLLOW_UP_VISIT'),
  (2, 58, 'FOLLOW_UP_VISIT'),
  (2, 59, 'FOLLOW_UP_VISIT'),
  (2, 60, 'FOLLOW_UP_VISIT'),
  (2, 61, 'FIRST_CONSULTATION'),
  (2, 62, 'FOLLOW_UP_VISIT'),
  (2, 63, 'FOLLOW_UP_VISIT'),
  (2, 64, 'FOLLOW_UP_VISIT'),
  (2, 65, 'FOLLOW_UP_VISIT'),
  (2, 66, 'FIRST_CONSULTATION'),
  (2, 67, 'FOLLOW_UP_VISIT'),
  (2, 68, 'FOLLOW_UP_VISIT'),
  (2, 69, 'FOLLOW_UP_VISIT'),
  (2, 70, 'FOLLOW_UP_VISIT')
ON DUPLICATE KEY UPDATE
  `visit_type_code` = VALUES(`visit_type_code`),
  `updated_at` = CURRENT_TIMESTAMP;



ALTER TABLE `tbl_branch_token_layouts`
  ADD COLUMN IF NOT EXISTS `duration_minutes` DECIMAL(5,2) NULL AFTER `visit_type_code`;

-- Branch 1: first 9 follow-up tokens use 5 minutes; remaining follow-up tokens use 4 minutes.
-- Non-follow-up durations are stored explicitly to keep the whole plate DB-defined.
UPDATE `tbl_branch_token_layouts`
SET `duration_minutes` = CASE
  WHEN `visit_type_code` = 'ACUTE_TREATMENT' THEN 2.00
  WHEN `visit_type_code` = 'FIRST_CONSULTATION' THEN 10.00
  WHEN `visit_type_code` = 'CHRONIC_CASE_DISCUSSION' THEN 14.00
  WHEN `visit_type_code` = 'FOLLOW_UP_VISIT'
       AND `token_number` IN (1, 2, 3, 4, 7, 8, 9, 12, 13) THEN 5.00
  WHEN `visit_type_code` = 'FOLLOW_UP_VISIT' THEN 4.00
  ELSE `duration_minutes`
END
WHERE `fk_branch_id` = 1;

-- Branch 2: Devendra Nagar 70-token schedule with 18 follow-up slots at 5 minutes
-- and all remaining follow-up slots at 4 minutes.
UPDATE `tbl_branch_token_layouts`
SET `duration_minutes` = CASE
  WHEN `visit_type_code` = 'ACUTE_TREATMENT' THEN 2.00
  WHEN `visit_type_code` = 'FIRST_CONSULTATION' THEN 10.00
  WHEN `visit_type_code` = 'CHRONIC_CASE_DISCUSSION' THEN 14.00
  WHEN `visit_type_code` = 'FOLLOW_UP_VISIT'
       AND `token_number` IN (1, 2, 3, 4, 12, 13, 14, 22, 23, 24, 28, 32, 33, 42, 43, 52, 53, 62) THEN 5.00
  WHEN `visit_type_code` = 'FOLLOW_UP_VISIT' THEN 4.00
  ELSE `duration_minutes`
END
WHERE `fk_branch_id` = 2;



UPDATE `tbl_branch_token_layouts`
SET
  `visit_type_code` = 'ACUTE_TREATMENT',
  `duration_minutes` = 2.00
WHERE `fk_branch_id` = 1
  AND `token_number` = 38;

UPDATE `tbl_branch_token_layouts`
SET
  `visit_type_code` = 'FIRST_CONSULTATION',
  `duration_minutes` = 10.00
WHERE `fk_branch_id` = 1
  AND `token_number` = 39;



