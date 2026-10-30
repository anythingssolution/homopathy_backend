-- migration: retry-safe
-- Standardize the existing branch's display name without changing its ID,
-- contacts, timings, access, appointments or booking rules. MySQL/MariaDB DML only.

UPDATE master_clinic_branches
SET branch_name = 'Devendra Nagar Branch'
WHERE id = 2
  AND LOWER(TRIM(branch_name)) IN ('pandri', 'pandri branch', 'pandri clinic', 'devendra nagar, pandri clinic');

UPDATE master_clinic_branches
SET address = REPLACE(address, 'clinic Pandri,', 'clinic,')
WHERE id = 2
  AND address LIKE '%clinic Pandri,%';

UPDATE tbl_branch_recurring_schedule_rules
SET rule_description = REPLACE(
    REPLACE(rule_description, 'Devendra Nagar (Pandri Branch)', 'Devendra Nagar'),
    'Pandri Branch', 'Devendra Nagar Branch'
)
WHERE fk_branch_id = 2
  AND rule_description LIKE '%Pandri Branch%';
