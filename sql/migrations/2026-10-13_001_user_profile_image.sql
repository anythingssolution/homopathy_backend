-- migration: retry-safe

SET @profile_image_alter_clauses = '';

SET @profile_image_object_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'master_users' AND COLUMN_NAME = 'profile_image_url');
SET @profile_image_alter_clauses = CONCAT_WS(', ', NULLIF(@profile_image_alter_clauses, ''),
  IF(@profile_image_object_exists = 0, 'ADD COLUMN `profile_image_url` VARCHAR(700) NULL AFTER `description`', NULL));

SET @profile_image_object_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'master_users' AND COLUMN_NAME = 'profile_image_key');
SET @profile_image_alter_clauses = CONCAT_WS(', ', NULLIF(@profile_image_alter_clauses, ''),
  IF(@profile_image_object_exists = 0, 'ADD COLUMN `profile_image_key` VARCHAR(700) NULL AFTER `profile_image_url`', NULL));

SET @profile_image_object_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'master_users' AND COLUMN_NAME = 'profile_image_mime_type');
SET @profile_image_alter_clauses = CONCAT_WS(', ', NULLIF(@profile_image_alter_clauses, ''),
  IF(@profile_image_object_exists = 0, 'ADD COLUMN `profile_image_mime_type` VARCHAR(100) NULL AFTER `profile_image_key`', NULL));

SET @profile_image_object_exists = (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'master_users' AND COLUMN_NAME = 'profile_image_size');
SET @profile_image_alter_clauses = CONCAT_WS(', ', NULLIF(@profile_image_alter_clauses, ''),
  IF(@profile_image_object_exists = 0, 'ADD COLUMN `profile_image_size` BIGINT UNSIGNED NULL AFTER `profile_image_mime_type`', NULL));

SET @profile_image_alter_sql = IF(@profile_image_alter_clauses = '', 'SELECT 1',
  CONCAT('ALTER TABLE `master_users` ', @profile_image_alter_clauses));
PREPARE profile_image_migration FROM @profile_image_alter_sql;
EXECUTE profile_image_migration;
DEALLOCATE PREPARE profile_image_migration;
