CREATE TABLE IF NOT EXISTS tbl_medical_payment_corrections (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    bill_id BIGINT UNSIGNED NOT NULL,
    old_paid_amount DECIMAL(12,2) NOT NULL,
    new_paid_amount DECIMAL(12,2) NOT NULL,
    receipt_snapshot JSON NOT NULL,
    corrected_by BIGINT UNSIGNED NOT NULL,
    request_key VARCHAR(100) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_medical_correction_bill (bill_id)
) ENGINE=InnoDB;
