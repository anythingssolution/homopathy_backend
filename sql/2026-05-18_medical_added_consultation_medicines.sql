ALTER TABLE tbl_consultation_medications
  ADD COLUMN added_by_role ENUM('DOCTOR', 'MEDICAL') NOT NULL DEFAULT 'DOCTOR' AFTER remark;

CREATE INDEX idx_consultation_medications_role
  ON tbl_consultation_medications (consultation_id, added_by_role);
