ALTER TABLE tbl_bills
  ADD COLUMN gross_amount DECIMAL(10,2) NOT NULL DEFAULT 0.00 AFTER fk_branch_id,
  ADD COLUMN discount_amount DECIMAL(10,2) NOT NULL DEFAULT 0.00 AFTER gross_amount;

UPDATE tbl_bills
SET gross_amount = total_amount,
    discount_amount = 0.00
WHERE gross_amount = 0.00
  AND discount_amount = 0.00;

ALTER TABLE tbl_medical_prescription_pricing
  ADD COLUMN discounts_json JSON NULL AFTER remark;

CREATE TABLE IF NOT EXISTS tbl_bill_discounts (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  bill_id BIGINT UNSIGNED NOT NULL,
  discount_category ENUM('CONSULTATION', 'MEDICINE', 'TEST', 'COURIER') NOT NULL,
  discount_type ENUM('AMOUNT') NOT NULL DEFAULT 'AMOUNT',
  discount_value DECIMAL(10,2) NOT NULL,
  discount_amount DECIMAL(10,2) NOT NULL,
  reason_code VARCHAR(60) NOT NULL,
  reason_note VARCHAR(255) NULL,
  status ENUM('ACTIVE', 'VOID') NOT NULL DEFAULT 'ACTIVE',
  created_by BIGINT UNSIGNED NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  voided_by BIGINT UNSIGNED NULL,
  voided_at TIMESTAMP NULL DEFAULT NULL,
  void_reason VARCHAR(255) NULL,
  PRIMARY KEY (id),
  KEY idx_bill_discounts_bill_status (bill_id, status),
  KEY idx_bill_discounts_category (discount_category, status),
  CONSTRAINT fk_bill_discounts_bill FOREIGN KEY (bill_id) REFERENCES tbl_bills (id),
  CONSTRAINT fk_bill_discounts_created_by FOREIGN KEY (created_by) REFERENCES master_users (id),
  CONSTRAINT fk_bill_discounts_voided_by FOREIGN KEY (voided_by) REFERENCES master_users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
