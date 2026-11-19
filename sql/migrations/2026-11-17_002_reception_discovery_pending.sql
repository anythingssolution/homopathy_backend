-- migration: retry-safe
-- Only new receptionist bookings are tracked. Existing answers remain untouched.
CREATE TABLE IF NOT EXISTS tbl_reception_discovery_pending (
 appointment_id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
 actor_id BIGINT UNSIGNED NOT NULL,
 created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
 KEY idx_reception_source_actor (actor_id, appointment_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
