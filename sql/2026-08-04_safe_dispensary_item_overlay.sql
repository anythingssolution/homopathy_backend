ALTER TABLE tbl_medical_prescription_pricing_items
  ADD COLUMN dispense_status ENUM('ACTIVE', 'VOID') NOT NULL DEFAULT 'ACTIVE' AFTER amount,
  ADD COLUMN void_reason VARCHAR(255) NULL AFTER dispense_status,
  ADD COLUMN voided_by BIGINT UNSIGNED NULL AFTER void_reason,
  ADD COLUMN voided_at TIMESTAMP NULL DEFAULT NULL AFTER voided_by,
  ADD COLUMN version INT UNSIGNED NOT NULL DEFAULT 1 AFTER voided_at;

ALTER TABLE tbl_medical_prescription_pricing_items
  ADD CONSTRAINT fk_medical_pricing_items_voided_by
    FOREIGN KEY (voided_by) REFERENCES master_users (id);

ALTER TABLE tbl_medical_prescription_pricing_items
  ADD UNIQUE KEY uq_medical_pricing_item_medication (pricing_id, consultation_medication_id),
  ADD KEY idx_medical_pricing_items_status (pricing_id, dispense_status);

CREATE TABLE IF NOT EXISTS tbl_medical_dispensing_item_events (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  pricing_item_id BIGINT UNSIGNED NULL,
  consultation_id BIGINT UNSIGNED NOT NULL,
  consultation_medication_id BIGINT UNSIGNED NULL,
  medicine_value VARCHAR(255) NOT NULL,
  event_type ENUM('CREATED', 'PRICE_UPDATED', 'VOIDED', 'RESTORED') NOT NULL,
  old_amount DECIMAL(10,2) NULL,
  new_amount DECIMAL(10,2) NULL,
  old_status ENUM('ACTIVE', 'VOID') NULL,
  new_status ENUM('ACTIVE', 'VOID') NOT NULL,
  reason VARCHAR(255) NULL,
  actor_user_id BIGINT UNSIGNED NOT NULL,
  actor_role VARCHAR(20) NOT NULL,
  request_key VARCHAR(100) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_dispensing_events_consultation (consultation_id, created_at),
  KEY idx_dispensing_events_pricing_item (pricing_item_id, created_at),
  CONSTRAINT fk_dispensing_events_pricing_item
    FOREIGN KEY (pricing_item_id) REFERENCES tbl_medical_prescription_pricing_items (id)
    ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT fk_dispensing_events_consultation
    FOREIGN KEY (consultation_id) REFERENCES tbl_consultations (id),
  CONSTRAINT fk_dispensing_events_medication
    FOREIGN KEY (consultation_medication_id) REFERENCES tbl_consultation_medications (id)
    ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT fk_dispensing_events_actor
    FOREIGN KEY (actor_user_id) REFERENCES master_users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS tbl_medical_dispensing_requests (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  consultation_id BIGINT UNSIGNED NOT NULL,
  request_key VARCHAR(100) NOT NULL,
  request_type ENUM('SAVE', 'PROCESS') NOT NULL,
  created_by BIGINT UNSIGNED NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_medical_dispensing_request (consultation_id, request_key),
  CONSTRAINT fk_dispensing_requests_consultation
    FOREIGN KEY (consultation_id) REFERENCES tbl_consultations (id),
  CONSTRAINT fk_dispensing_requests_created_by
    FOREIGN KEY (created_by) REFERENCES master_users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

UPDATE tbl_medical_prescription_pricing_items
SET dispense_status = 'ACTIVE',
    version = GREATEST(COALESCE(version, 1), 1)
WHERE dispense_status IS NULL OR version IS NULL OR version = 0;
