ALTER TABLE master_clinic_branches
  ADD COLUMN IF NOT EXISTS follow_up_free_days SMALLINT UNSIGNED NULL AFTER branch_name;

UPDATE master_clinic_branches
SET follow_up_free_days = CASE id
  WHEN 1 THEN 60
  WHEN 2 THEN 30
  ELSE follow_up_free_days
END
WHERE id IN (1, 2);
