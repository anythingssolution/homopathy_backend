ALTER TABLE tbl_medication_dosages
  DROP INDEX uq_medication_dosage_consultation_medication,
  ADD COLUMN dose_label VARCHAR(50) NULL AFTER consultation_medication_id,
  ADD COLUMN sort_order TINYINT UNSIGNED NOT NULL DEFAULT 1 AFTER dose_label,
  ADD KEY idx_medication_dosages_consultation_medication_order (consultation_medication_id, sort_order);

UPDATE tbl_medication_dosages
SET dose_label = COALESCE(dose_label, CONCAT('DOSE_', sort_order))
WHERE dose_label IS NULL;
