

ALTER TABLE `master_treatments`
  MODIFY COLUMN `estimated_duration_minutes` DECIMAL(5,2) NULL COMMENT 'Duration in minutes';

UPDATE `master_treatments`
SET `estimated_duration_minutes` = CASE `treatment_name`
  WHEN 'Follow-up Visit' THEN 4.50
  WHEN 'First Consultation' THEN 10.00
  WHEN 'Acute Treatment' THEN 2.00
  WHEN 'Chronic Case Discussion' THEN 14.00
  ELSE `estimated_duration_minutes`
END
WHERE `treatment_name` IN (
  'Follow-up Visit',
  'First Consultation',
  'Acute Treatment',
  'Chronic Case Discussion'
);


