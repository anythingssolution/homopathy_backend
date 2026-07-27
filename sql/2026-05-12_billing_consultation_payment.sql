ALTER TABLE master_treatments
  ADD COLUMN IF NOT EXISTS consultation_fee DECIMAL(10,2) NOT NULL DEFAULT 0.00 AFTER estimated_duration_minutes;

ALTER TABLE tbl_appointments
  ADD COLUMN IF NOT EXISTS consultation_payment_status VARCHAR(20) NOT NULL DEFAULT 'UNPAID' AFTER reception_status,
  ADD COLUMN IF NOT EXISTS consultation_bill_id BIGINT(20) UNSIGNED NULL AFTER consultation_payment_status,
  ADD COLUMN IF NOT EXISTS payment_collected_at TIMESTAMP NULL DEFAULT NULL AFTER consultation_bill_id,
  ADD COLUMN IF NOT EXISTS payment_collected_by BIGINT(20) UNSIGNED NULL AFTER payment_collected_at;

CREATE TABLE IF NOT EXISTS tbl_bills (
  id BIGINT(20) UNSIGNED NOT NULL AUTO_INCREMENT,
  bill_number VARCHAR(32) NOT NULL,
  bill_type VARCHAR(20) NOT NULL,
  appointment_id BIGINT(20) UNSIGNED DEFAULT NULL,
  consultation_id BIGINT(20) UNSIGNED DEFAULT NULL,
  patient_id BIGINT(20) UNSIGNED NOT NULL,
  fk_branch_id BIGINT(20) UNSIGNED DEFAULT NULL,
  total_amount DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  paid_amount DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  pending_amount DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  payment_status VARCHAR(20) NOT NULL DEFAULT 'UNPAID',
  status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
  remark VARCHAR(255) DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by BIGINT(20) UNSIGNED DEFAULT NULL,
  updated_by BIGINT(20) UNSIGNED DEFAULT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_tbl_bills_bill_number (bill_number),
  KEY idx_tbl_bills_bill_type (bill_type, payment_status, status),
  KEY idx_tbl_bills_appointment (appointment_id),
  KEY idx_tbl_bills_consultation (consultation_id),
  KEY idx_tbl_bills_patient (patient_id),
  CONSTRAINT fk_tbl_bills_appointment FOREIGN KEY (appointment_id) REFERENCES tbl_appointments (appointment_id),
  CONSTRAINT fk_tbl_bills_consultation FOREIGN KEY (consultation_id) REFERENCES tbl_consultations (id),
  CONSTRAINT fk_tbl_bills_patient FOREIGN KEY (patient_id) REFERENCES master_users (id),
  CONSTRAINT fk_tbl_bills_branch FOREIGN KEY (fk_branch_id) REFERENCES master_clinic_branches (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS tbl_bill_payments (
  id BIGINT(20) UNSIGNED NOT NULL AUTO_INCREMENT,
  bill_id BIGINT(20) UNSIGNED NOT NULL,
  appointment_id BIGINT(20) UNSIGNED DEFAULT NULL,
  consultation_id BIGINT(20) UNSIGNED DEFAULT NULL,
  patient_id BIGINT(20) UNSIGNED NOT NULL,
  payment_for VARCHAR(20) NOT NULL,
  amount DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  payment_mode VARCHAR(20) NOT NULL,
  transaction_reference VARCHAR(150) DEFAULT NULL,
  remark VARCHAR(255) DEFAULT NULL,
  collected_by_user_id BIGINT(20) UNSIGNED NOT NULL,
  collected_by_role VARCHAR(20) NOT NULL,
  collected_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  status VARCHAR(20) NOT NULL DEFAULT 'SUCCESS',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_tbl_bill_payments_bill (bill_id, collected_at),
  KEY idx_tbl_bill_payments_appointment (appointment_id),
  CONSTRAINT fk_tbl_bill_payments_bill FOREIGN KEY (bill_id) REFERENCES tbl_bills (id),
  CONSTRAINT fk_tbl_bill_payments_appointment FOREIGN KEY (appointment_id) REFERENCES tbl_appointments (appointment_id),
  CONSTRAINT fk_tbl_bill_payments_consultation FOREIGN KEY (consultation_id) REFERENCES tbl_consultations (id),
  CONSTRAINT fk_tbl_bill_payments_patient FOREIGN KEY (patient_id) REFERENCES master_users (id),
  CONSTRAINT fk_tbl_bill_payments_collected_by FOREIGN KEY (collected_by_user_id) REFERENCES master_users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS tbl_bill_items (
  id BIGINT(20) UNSIGNED NOT NULL AUTO_INCREMENT,
  bill_id BIGINT(20) UNSIGNED NOT NULL,
  consultation_medication_id BIGINT(20) UNSIGNED DEFAULT NULL,
  item_name VARCHAR(255) NOT NULL,
  quantity DECIMAL(10,2) NOT NULL DEFAULT 1.00,
  unit_price DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  amount DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_tbl_bill_items_bill (bill_id),
  CONSTRAINT fk_tbl_bill_items_bill FOREIGN KEY (bill_id) REFERENCES tbl_bills (id),
  CONSTRAINT fk_tbl_bill_items_consultation_med FOREIGN KEY (consultation_medication_id) REFERENCES tbl_consultation_medications (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE INDEX idx_tbl_appointments_consultation_payment
ON tbl_appointments (reception_status, consultation_payment_status, appointment_date, fk_branch_id, fk_slot_id);
