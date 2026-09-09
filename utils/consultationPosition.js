// Completion order within a branch/date/slot, independent of list filters and pagination.
// The appointment table must be aliased as a. Missing completion times have no position.
const consultationPositionSql = `CASE WHEN a.status = 'Completed' AND a.actual_completed_at IS NOT NULL THEN (
                SELECT COUNT(*)
                FROM tbl_appointments completed
                WHERE completed.fk_branch_id = a.fk_branch_id
                  AND completed.fk_slot_id = a.fk_slot_id
                  AND completed.appointment_date = a.appointment_date
                  AND completed.is_active = 1
                  AND completed.status = 'Completed'
                  AND (completed.actual_completed_at < a.actual_completed_at
                    OR (completed.actual_completed_at = a.actual_completed_at
                      AND completed.appointment_id <= a.appointment_id))
            ) ELSE NULL END`;

module.exports = { consultationPositionSql };
