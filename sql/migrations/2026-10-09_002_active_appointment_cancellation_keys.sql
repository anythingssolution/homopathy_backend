-- migration: retry-safe
-- Cancelled history must not occupy an active booking's unique key.
-- Apply all index changes together so active token protection is never absent.
ALTER TABLE `tbl_appointments`
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
    ) STORED,
  ADD UNIQUE INDEX IF NOT EXISTS `uq_appointment_active_token_booking` (`active_token_booking_key`),
  ADD INDEX IF NOT EXISTS `idx_appointment_booking_subject_date_active` (`booking_subject_key`, `appointment_date`, `is_active`),
  DROP INDEX IF EXISTS `uq_appointment_branch_slot_date_token_active`,
  DROP INDEX IF EXISTS `uq_appointment_booking_subject_date_active`,
  DROP INDEX IF EXISTS `uq_appointment_patient_branch_slot_date_active`,
  DROP INDEX IF EXISTS `uq_appointment_patient_date_active`,
  DROP INDEX IF EXISTS `uq_appointment_active_subject_date`,
  DROP COLUMN IF EXISTS `active_booking_subject_date_key`;
