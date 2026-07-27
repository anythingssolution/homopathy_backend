INSERT INTO master_roles (role_name, role_code, status)
VALUES
  ('Doctor', 'DOC', 1),
  ('Receptionist', 'REC', 1),
  ('Medical', 'MED', 1),
  ('Patient', 'PAT', 1)
ON DUPLICATE KEY UPDATE
  role_name = VALUES(role_name),
  status = VALUES(status);

UPDATE master_users
SET role = CASE UPPER(TRIM(role))
  WHEN 'PATIENT' THEN 'PAT'
  WHEN 'PAT' THEN 'PAT'
  WHEN 'DOCTOR' THEN 'DOC'
  WHEN 'DOC' THEN 'DOC'
  WHEN 'RECEPTIONIST' THEN 'REC'
  WHEN 'REC' THEN 'REC'
  WHEN 'MEDICAL_STAFF' THEN 'MED'
  WHEN 'MEDS' THEN 'MED'
  WHEN 'MEDICAL' THEN 'MED'
  WHEN 'MED' THEN 'MED'
  ELSE role
END;

ALTER TABLE master_users
  MODIFY role VARCHAR(20) NOT NULL DEFAULT 'PAT';

ALTER TABLE tbl_user_otps
  MODIFY purpose ENUM('register','login','forgot_password') NOT NULL;

ALTER TABLE tbl_appointments
  ADD COLUMN auid VARCHAR(24) NULL AFTER appointment_id,
  ADD COLUMN cancelled_at TIMESTAMP NULL DEFAULT NULL AFTER status,
  ADD COLUMN cancelled_by_user_id BIGINT UNSIGNED NULL AFTER cancelled_at,
  ADD COLUMN cancelled_by_role VARCHAR(20) NULL AFTER cancelled_by_user_id,
  ADD COLUMN cancel_reason VARCHAR(255) NULL AFTER cancelled_by_role,
  ADD UNIQUE KEY uq_appointment_auid (auid),
  ADD KEY con_fk_apt_cancelled_by (cancelled_by_user_id),
  ADD CONSTRAINT con_fk_apt_cancelled_by FOREIGN KEY (cancelled_by_user_id) REFERENCES master_users (id),
  DROP INDEX uq_appointment_patient_branch_slot_date,
  DROP INDEX uq_appointment_branch_slot_date_token,
  ADD UNIQUE KEY uq_appointment_patient_branch_slot_date_active (fk_patient_id, fk_branch_id, fk_slot_id, appointment_date, is_active),
  ADD UNIQUE KEY uq_appointment_branch_slot_date_token_active (fk_branch_id, fk_slot_id, appointment_date, token_number, is_active);
