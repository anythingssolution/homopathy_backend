ALTER TABLE `tbl_appointments`
  DROP INDEX IF EXISTS `uq_appointment_branch_slot_date_token_active`,
  DROP INDEX IF EXISTS `uq_appointment_booking_subject_date_active`,
  DROP INDEX IF EXISTS `uq_appointment_patient_date_active`,
  DROP INDEX IF EXISTS `uq_appointment_active_subject_date`;

ALTER TABLE `tbl_appointments`
  DROP COLUMN IF EXISTS `active_booking_subject_date_key`,
  ADD COLUMN IF NOT EXISTS `active_token_booking_key` VARCHAR(120)
    GENERATED ALWAYS AS (
      CASE
        WHEN `is_active` = 1
          AND `status` <> 'Cancelled'
          AND COALESCE(`reception_status`, '') <> 'REJECTED_BY_RECEPTION'
          AND COALESCE(`queue_status`, '') <> 'CANCELLED'
        THEN CONCAT(
          `fk_branch_id`, ':',
          `fk_slot_id`, ':',
          `appointment_date`, ':',
          `token_number`
        )
        ELSE NULL
      END
    ) STORED;

CREATE UNIQUE INDEX IF NOT EXISTS `uq_appointment_active_token_booking`
  ON `tbl_appointments` (`active_token_booking_key`);

CREATE INDEX IF NOT EXISTS `idx_appointment_booking_subject_date_active`
  ON `tbl_appointments` (`booking_subject_key`, `appointment_date`, `is_active`);


UPDATE `tbl_appointments`
SET `is_active` = 0,
    `status` = 'Cancelled',
    `queue_status` = 'CANCELLED',
    `updated_at` = CURRENT_TIMESTAMP
WHERE `is_active` = 1
  AND (
    `status` = 'Cancelled'
    OR `reception_status` = 'REJECTED_BY_RECEPTION'
    OR `queue_status` = 'CANCELLED'
  );