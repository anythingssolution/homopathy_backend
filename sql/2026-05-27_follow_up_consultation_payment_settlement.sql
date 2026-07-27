ALTER TABLE tbl_bills
  ADD COLUMN IF NOT EXISTS payment_settlement_type VARCHAR(20) NOT NULL DEFAULT 'COLLECTED' AFTER payment_status;

ALTER TABLE tbl_appointments
  ADD COLUMN IF NOT EXISTS consultation_payment_settlement_type VARCHAR(20) NOT NULL DEFAULT 'COLLECTED' AFTER consultation_payment_status;
