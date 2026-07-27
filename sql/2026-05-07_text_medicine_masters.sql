ALTER TABLE tbl_consultation_medications
  ADD COLUMN remark VARCHAR(255) NULL AFTER medicine_value;

CREATE TABLE IF NOT EXISTS master_text_medicines (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  medicine_value VARCHAR(255) NOT NULL,
  normalized_value VARCHAR(255) NOT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_master_text_medicines_normalized_value (normalized_value)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;

CREATE TABLE IF NOT EXISTS master_text_medicine_remarks (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  remark_value VARCHAR(255) NOT NULL,
  normalized_value VARCHAR(255) NOT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_master_text_medicine_remarks_normalized_value (normalized_value)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;
