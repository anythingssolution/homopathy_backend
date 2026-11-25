-- Select the clinic DB. Back up affected rows before execution.
-- MySQL/MariaDB compatible, safe to rerun. No schema/tracking-row changes.
START TRANSACTION;
UPDATE tbl_patient_discovery_sources
SET source_code = 'OTHER',
    other_detail = COALESCE(NULLIF(TRIM(other_detail), ''), 'Patient does not know')
WHERE source_code = 'NOT_KNOWN';
SELECT ROW_COUNT() AS converted_answers;
COMMIT;
SELECT COUNT(*) AS remaining_unknown_answers
FROM tbl_patient_discovery_sources WHERE source_code = 'NOT_KNOWN';
