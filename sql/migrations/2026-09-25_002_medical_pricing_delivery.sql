ALTER TABLE tbl_medical_prescription_pricing
  ADD COLUMN delivery_mode VARCHAR(30) NOT NULL DEFAULT 'HAND_DELIVERY' AFTER discounts_json,
  ADD COLUMN courier_charge DECIMAL(10,2) NOT NULL DEFAULT 0.00 AFTER delivery_mode,
  ADD COLUMN delivery_details_json JSON NULL AFTER courier_charge;
