CREATE TABLE IF NOT EXISTS tbl_medical_prescription_pricing (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  consultation_id BIGINT UNSIGNED NOT NULL,
  total_amount DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  remark VARCHAR(255) NULL,
  created_by BIGINT UNSIGNED NULL,
  updated_by BIGINT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_medical_prescription_pricing_consultation (consultation_id),
  CONSTRAINT fk_medical_prescription_pricing_consultation
    FOREIGN KEY (consultation_id) REFERENCES tbl_consultations (id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_medical_prescription_pricing_created_by
    FOREIGN KEY (created_by) REFERENCES master_users (id),
  CONSTRAINT fk_medical_prescription_pricing_updated_by
    FOREIGN KEY (updated_by) REFERENCES master_users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;

CREATE TABLE IF NOT EXISTS tbl_medical_prescription_pricing_items (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  pricing_id BIGINT UNSIGNED NOT NULL,
  consultation_medication_id BIGINT UNSIGNED NULL,
  medicine_value VARCHAR(255) NOT NULL,
  amount DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_medical_prescription_pricing_items_pricing (pricing_id),
  KEY idx_medical_prescription_pricing_items_medication (consultation_medication_id),
  CONSTRAINT fk_medical_prescription_pricing_items_pricing
    FOREIGN KEY (pricing_id) REFERENCES tbl_medical_prescription_pricing (id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_medical_prescription_pricing_items_medication
    FOREIGN KEY (consultation_medication_id) REFERENCES tbl_consultation_medications (id)
    ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;
