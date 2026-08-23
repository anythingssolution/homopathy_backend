INSERT INTO master_text_medicine_remarks
  (remark_value, normalized_value, selection_value, normalized_selection_value,
   medicine_value, variant_value, normalized_medicine_value, normalized_variant_value, is_active)
VALUES
  ('20 drop for 3 times in a day', '20 drop for 3 times in a day', '__UNIVERSAL_REMARK__', '__universal_remark__', '', '', '', '', 1),
  ('30 drop for 2 times in a day', '30 drop for 2 times in a day', '__UNIVERSAL_REMARK__', '__universal_remark__', '', '', '', '', 1),
  ('1 spoon', '1 spoon', '__UNIVERSAL_REMARK__', '__universal_remark__', '', '', '', '', 1),
  ('2 spoon', '2 spoon', '__UNIVERSAL_REMARK__', '__universal_remark__', '', '', '', '', 1),
  ('3 spoon', '3 spoon', '__UNIVERSAL_REMARK__', '__universal_remark__', '', '', '', '', 1)
ON DUPLICATE KEY UPDATE
  remark_value = VALUES(remark_value),
  is_active = 1;

INSERT INTO master_text_medicine_remarks
  (remark_value, normalized_value, selection_value, normalized_selection_value,
   medicine_value, variant_value, normalized_medicine_value, normalized_variant_value, is_active)
SELECT
  TRIM(c.universal_remark),
  LOWER(TRIM(c.universal_remark)),
  '__UNIVERSAL_REMARK__',
  '__universal_remark__',
  '',
  '',
  '',
  '',
  1
FROM tbl_consultations c
WHERE c.universal_remark IS NOT NULL
  AND TRIM(c.universal_remark) <> ''
ON DUPLICATE KEY UPDATE
  remark_value = VALUES(remark_value),
  is_active = 1;
