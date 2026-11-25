-- migration: retry-safe
-- Preserve the original answer meaning, patient/family attribution and timestamp.
UPDATE tbl_patient_discovery_sources
SET source_code = 'OTHER',
    other_detail = COALESCE(NULLIF(TRIM(other_detail), ''), 'Patient does not know')
WHERE source_code = 'NOT_KNOWN';
