ALTER TABLE master_text_medicines
  ADD COLUMN is_doctor_manual TINYINT(1) NOT NULL DEFAULT 0 AFTER is_active;

ALTER TABLE master_medical_products
  MODIFY source_type ENUM(
    'REGULAR_PRODUCT',
    'RADIENT_PHARMA',
    'MEDICAL_PRODUCT_PRICE',
    'DOCTOR_MANUAL'
  ) NOT NULL;
