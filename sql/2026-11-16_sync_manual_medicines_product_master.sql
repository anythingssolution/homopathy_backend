-- Manual one-time data repair. Select the clinic database in your SQL client.
-- Run this complete file before uploading the matching backend code.
-- Uses existing tables only; no DDL and no schema_migrations changes.
-- MySQL / MariaDB: INSERT ... SELECT, NOT EXISTS and a no-op duplicate-key update.
-- No fixed local IDs, product merging, history edits, price guesses or reactivation.

-- Preview: these active doctor-added names have no product, including inactive ones.
SELECT mtm.id AS medicine_id, mtm.medicine_value
FROM master_text_medicines mtm
LEFT JOIN master_medical_products existing_product
  ON existing_product.medicine_text_id = mtm.id
  OR existing_product.normalized_product_name = LOWER(TRIM(mtm.medicine_value))
WHERE mtm.is_active = 1
  AND mtm.is_doctor_manual = 1
  AND TRIM(mtm.medicine_value) <> ''
  AND existing_product.id IS NULL
ORDER BY mtm.medicine_value, mtm.id;

START TRANSACTION;

INSERT INTO master_medical_products
    (medicine_text_id, source_type, product_name, packing, mrp_rate,
     normalized_product_name, dedupe_key, is_active)
SELECT mtm.id, 'DOCTOR_MANUAL', UPPER(TRIM(mtm.medicine_value)), 'N/A', NULL,
       LOWER(TRIM(mtm.medicine_value)),
       CONCAT(LOWER(TRIM(mtm.medicine_value)), '|n/a|'), 1
FROM master_text_medicines mtm
LEFT JOIN master_medical_products existing_product
  ON existing_product.medicine_text_id = mtm.id
  OR existing_product.normalized_product_name = LOWER(TRIM(mtm.medicine_value))
WHERE mtm.is_active = 1
  AND mtm.is_doctor_manual = 1
  AND TRIM(mtm.medicine_value) <> ''
  AND existing_product.id IS NULL
ON DUPLICATE KEY UPDATE id = master_medical_products.id;

SELECT ROW_COUNT() AS inserted_product_rows;

COMMIT;

-- Expected 0. Rerunning after a Product Master deletion does not restore that row.
SELECT COUNT(*) AS remaining_manual_names_without_product
FROM master_text_medicines mtm
WHERE mtm.is_active = 1
  AND mtm.is_doctor_manual = 1
  AND TRIM(mtm.medicine_value) <> ''
  AND NOT EXISTS (
    SELECT 1 FROM master_medical_products mmp
    WHERE mmp.medicine_text_id = mtm.id
       OR mmp.normalized_product_name = LOWER(TRIM(mtm.medicine_value))
  );
