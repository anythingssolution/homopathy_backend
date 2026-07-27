ALTER TABLE master_users
    ADD COLUMN has_cross_module_access TINYINT(1) NOT NULL DEFAULT 0 AFTER role;

UPDATE master_users
SET has_cross_module_access = 0
WHERE has_cross_module_access IS NULL;
