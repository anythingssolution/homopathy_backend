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
