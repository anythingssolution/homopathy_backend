ALTER TABLE tbl_consultations
  ADD COLUMN IF NOT EXISTS is_repeat TINYINT(1) NOT NULL DEFAULT 0 AFTER repeated_from_consultation_id;

ALTER TABLE tbl_consultations
  ADD COLUMN IF NOT EXISTS is_same TINYINT(1) NOT NULL DEFAULT 0 AFTER is_repeat;

ALTER TABLE tbl_consultations
  MODIFY medication_duration_days SMALLINT UNSIGNED NOT NULL;
