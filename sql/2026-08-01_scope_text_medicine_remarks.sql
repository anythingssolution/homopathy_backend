ALTER TABLE master_text_medicine_remarks
  ADD COLUMN IF NOT EXISTS selection_value VARCHAR(255) NOT NULL DEFAULT '' AFTER normalized_value,
  ADD COLUMN IF NOT EXISTS normalized_selection_value VARCHAR(255) NOT NULL DEFAULT '' AFTER selection_value,
  ADD COLUMN IF NOT EXISTS medicine_value VARCHAR(255) NULL AFTER normalized_selection_value,
  ADD COLUMN IF NOT EXISTS variant_value VARCHAR(255) NULL AFTER medicine_value,
  ADD COLUMN IF NOT EXISTS normalized_medicine_value VARCHAR(255) NULL AFTER variant_value,
  ADD COLUMN IF NOT EXISTS normalized_variant_value VARCHAR(255) NULL AFTER normalized_medicine_value;

ALTER TABLE master_text_medicine_remarks
  DROP INDEX IF EXISTS uq_master_text_medicine_remarks_normalized_value;

ALTER TABLE master_text_medicine_remarks
  ADD UNIQUE KEY IF NOT EXISTS uq_master_text_medicine_remarks_selection_value (normalized_selection_value, normalized_value),
  ADD KEY IF NOT EXISTS idx_master_text_medicine_remarks_selection (normalized_selection_value, is_active);
