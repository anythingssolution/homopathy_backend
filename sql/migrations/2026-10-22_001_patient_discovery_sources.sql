-- migration: retry-safe
-- CREATE TABLE IF NOT EXISTS is supported by MySQL and MariaDB.
-- One answer per patient subject; family members have their own subject key.
CREATE TABLE IF NOT EXISTS tbl_patient_discovery_sources (
    subject_key VARCHAR(40) NOT NULL,
    patient_id BIGINT UNSIGNED NOT NULL,
    family_member_id BIGINT UNSIGNED NULL,
    appointment_id BIGINT UNSIGNED NOT NULL,
    source_code VARCHAR(30) NOT NULL,
    other_detail VARCHAR(255) NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (subject_key),
    KEY idx_discovery_appointment (appointment_id),
    KEY idx_discovery_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
