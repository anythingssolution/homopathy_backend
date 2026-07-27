ALTER TABLE tbl_consultations
  ADD COLUMN workflow_status ENUM(
    'DRAFT',
    'READY_FOR_RECEPTION',
    'APPROVED_BY_RECEPTION',
    'REJECTED_BY_RECEPTION',
    'READY_FOR_MEDICAL',
    'PROCESSED_BY_MEDICAL'
  ) NOT NULL DEFAULT 'DRAFT' AFTER medication_duration_days,
  ADD COLUMN doctor_finalized_at TIMESTAMP NULL DEFAULT NULL AFTER workflow_status,
  ADD COLUMN reception_notified_at TIMESTAMP NULL DEFAULT NULL AFTER doctor_finalized_at,
  ADD COLUMN reception_approved_at TIMESTAMP NULL DEFAULT NULL AFTER reception_notified_at,
  ADD COLUMN reception_approved_by BIGINT UNSIGNED NULL AFTER reception_approved_at,
  ADD COLUMN reception_rejected_at TIMESTAMP NULL DEFAULT NULL AFTER reception_approved_by,
  ADD COLUMN reception_rejected_by BIGINT UNSIGNED NULL AFTER reception_rejected_at,
  ADD COLUMN reception_rejection_reason VARCHAR(255) NULL AFTER reception_rejected_by,
  ADD COLUMN sent_to_medical_at TIMESTAMP NULL DEFAULT NULL AFTER reception_rejection_reason,
  ADD COLUMN medical_processed_at TIMESTAMP NULL DEFAULT NULL AFTER sent_to_medical_at,
  ADD COLUMN medical_processed_by BIGINT UNSIGNED NULL AFTER medical_processed_at,
  ADD KEY idx_consultations_workflow_status (workflow_status),
  ADD CONSTRAINT fk_consultation_reception_approved_by FOREIGN KEY (reception_approved_by) REFERENCES master_users (id),
  ADD CONSTRAINT fk_consultation_reception_rejected_by FOREIGN KEY (reception_rejected_by) REFERENCES master_users (id),
  ADD CONSTRAINT fk_consultation_medical_processed_by FOREIGN KEY (medical_processed_by) REFERENCES master_users (id);

CREATE TABLE IF NOT EXISTS tbl_notifications (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id BIGINT UNSIGNED NOT NULL,
  role_code VARCHAR(20) NOT NULL,
  type VARCHAR(100) NOT NULL,
  title VARCHAR(255) NOT NULL,
  message TEXT NOT NULL,
  entity_type VARCHAR(50) NOT NULL,
  entity_id BIGINT UNSIGNED NOT NULL,
  is_read TINYINT(1) NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  read_at TIMESTAMP NULL DEFAULT NULL,
  PRIMARY KEY (id),
  KEY idx_notifications_user_read (user_id, is_read, created_at),
  KEY idx_notifications_role_read (role_code, is_read, created_at),
  CONSTRAINT fk_notifications_user FOREIGN KEY (user_id) REFERENCES master_users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;
