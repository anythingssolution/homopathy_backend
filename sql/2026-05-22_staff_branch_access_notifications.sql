CREATE TABLE IF NOT EXISTS tbl_user_branch_access (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id BIGINT UNSIGNED NOT NULL,
  branch_id BIGINT UNSIGNED NOT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_user_branch_access (user_id, branch_id),
  KEY idx_user_branch_access_branch (branch_id, is_active),
  CONSTRAINT fk_user_branch_access_user FOREIGN KEY (user_id) REFERENCES master_users (id) ON DELETE CASCADE,
  CONSTRAINT fk_user_branch_access_branch FOREIGN KEY (branch_id) REFERENCES master_clinic_branches (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;

INSERT IGNORE INTO tbl_user_branch_access (user_id, branch_id, is_active)
SELECT u.id, b.id, 1
FROM master_users u
JOIN master_clinic_branches b ON b.is_active = 1
WHERE u.is_active = 1
  AND u.role IN ('DOC', 'REC', 'MED');

ALTER TABLE tbl_notifications
  ADD COLUMN branch_id BIGINT UNSIGNED NULL AFTER user_id,
  ADD KEY idx_notifications_branch_read (branch_id, is_read, created_at),
  ADD CONSTRAINT fk_notifications_branch FOREIGN KEY (branch_id) REFERENCES master_clinic_branches (id) ON DELETE SET NULL;

UPDATE tbl_notifications n
JOIN tbl_consultations c
  ON n.entity_type = 'consultation'
 AND c.id = n.entity_id
JOIN tbl_appointments a
  ON a.appointment_id = c.appointment_id
SET n.branch_id = a.fk_branch_id
WHERE n.branch_id IS NULL;
