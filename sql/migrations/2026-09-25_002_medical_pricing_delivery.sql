-- migration: retry-safe
-- migration: compatible-checksum 92058fbe1a8585c33e6206d92d134ff30b778827e74af9552f7c77a41e363e24
ALTER TABLE tbl_medical_prescription_pricing
  ADD COLUMN IF NOT EXISTS delivery_mode VARCHAR(30) NOT NULL DEFAULT 'HAND_DELIVERY' AFTER discounts_json,
  ADD COLUMN IF NOT EXISTS courier_charge DECIMAL(10,2) NOT NULL DEFAULT 0.00 AFTER delivery_mode,
  ADD COLUMN IF NOT EXISTS delivery_details_json JSON NULL AFTER courier_charge;
