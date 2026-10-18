-- migration: retry-safe
-- Additive only: an absent setting means the existing booking behaviour.
-- CREATE TABLE IF NOT EXISTS is supported by MySQL and MariaDB.
CREATE TABLE IF NOT EXISTS tbl_branch_slot_booking_weekdays (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    fk_slot_id BIGINT UNSIGNED NOT NULL,
    day_of_week TINYINT UNSIGNED NOT NULL COMMENT '1=Sunday, 2=Monday, ..., 7=Saturday',
    booking_enabled TINYINT UNSIGNED NOT NULL DEFAULT 1,
    created_by BIGINT UNSIGNED DEFAULT NULL,
    updated_by BIGINT UNSIGNED DEFAULT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_slot_booking_weekday (fk_slot_id, day_of_week)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
