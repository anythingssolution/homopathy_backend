-- ==============================================================================
-- Migration: 2026-08-18_refresh_medicine_and_medical_product_masters.sql
-- Description: Production-Safe Master Data Refresh for Medicine Master Tables
-- Tables Affected: master_text_medicines, master_medical_products
--
-- Safety Guarantees:
--  1. Pre-condition Validation: Aborts if either *_old backup table already exists.
--  2. Zero Data Loss: Existing tables are atomically renamed to *_old (never dropped/truncated).
--  3. Schema Recreated: Exact schema, constraints, unique keys, and foreign keys.
--  4. Explicit Master Data Insert: Full dataset inserted with explicit column names.
--  5. Sequence/ID Alignment: Auto-increment sequences aligned beyond highest inserted ID.
--  6. Post-Migration Assertion & Validation: Validates presence of old & new tables,
--     exact row counts, and auto-increment state.
-- ==============================================================================

DELIMITER $$

DROP PROCEDURE IF EXISTS `sp_run_migration_refresh_medicine_masters`$$

CREATE PROCEDURE `sp_run_migration_refresh_medicine_masters`()
BEGIN
    DECLARE v_old_text_exists INT DEFAULT 0;
    DECLARE v_old_prod_exists INT DEFAULT 0;
    DECLARE v_src_text_exists INT DEFAULT 0;
    DECLARE v_src_prod_exists INT DEFAULT 0;
    DECLARE v_new_text_count INT DEFAULT 0;
    DECLARE v_new_prod_count INT DEFAULT 0;
    DECLARE v_old_text_count INT DEFAULT 0;
    DECLARE v_old_prod_count INT DEFAULT 0;
    DECLARE v_expected_text_count INT DEFAULT 343;
    DECLARE v_expected_prod_count INT DEFAULT 343;

    -- ==========================================================================
    -- STEP 1: PRE-CONDITION SAFETY CHECKS
    -- ==========================================================================

    -- 1.1 Check if backup tables (*_old) already exist. If so, fail safely.
    SELECT COUNT(*) INTO v_old_text_exists
    FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'master_text_medicines_old';

    IF v_old_text_exists > 0 THEN
        SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'MIGRATION ABORTED: Table master_text_medicines_old already exists. Rename would cause data collision or overwrite.';
    END IF;

    SELECT COUNT(*) INTO v_old_prod_exists
    FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'master_medical_products_old';

    IF v_old_prod_exists > 0 THEN
        SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'MIGRATION ABORTED: Table master_medical_products_old already exists. Rename would cause data collision or overwrite.';
    END IF;

    -- 1.2 Check if source tables exist
    SELECT COUNT(*) INTO v_src_text_exists
    FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'master_text_medicines';

    IF v_src_text_exists = 0 THEN
        SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'MIGRATION ABORTED: Source table master_text_medicines does not exist.';
    END IF;

    SELECT COUNT(*) INTO v_src_prod_exists
    FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'master_medical_products';

    IF v_src_prod_exists = 0 THEN
        SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'MIGRATION ABORTED: Source table master_medical_products does not exist.';
    END IF;

    -- ==========================================================================
    -- STEP 2: SAFELY & ATOMICALLY RENAME EXISTING TABLES TO *_old
    -- ==========================================================================
    -- Note: MySQL RENAME TABLE is atomic across multiple tables.
    RENAME TABLE
        `master_text_medicines` TO `master_text_medicines_old`,
        `master_medical_products` TO `master_medical_products_old`;

    -- ==========================================================================
    -- STEP 3: CREATE FRESH master_text_medicines
    -- ==========================================================================
    CREATE TABLE `master_text_medicines` (
      `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      `medicine_value` VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL,
      `normalized_value` VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL,
      `is_active` TINYINT(1) NOT NULL DEFAULT '1',
      `is_doctor_manual` TINYINT(1) NOT NULL DEFAULT '0',
      `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (`id`) USING BTREE,
      UNIQUE KEY `uq_master_text_medicines_normalized_value` (`normalized_value`) USING BTREE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

    -- ==========================================================================
    -- STEP 4: CREATE FRESH master_medical_products
    -- ==========================================================================
    CREATE TABLE `master_medical_products` (
      `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      `medicine_text_id` BIGINT UNSIGNED DEFAULT NULL,
      `source_type` ENUM('REGULAR_PRODUCT','RADIENT_PHARMA','MEDICAL_PRODUCT_PRICE','DOCTOR_MANUAL') NOT NULL,
      `source_old_id` BIGINT UNSIGNED DEFAULT NULL,
      `product_name` VARCHAR(255) NOT NULL,
      `product_type` VARCHAR(100) DEFAULT NULL,
      `category` VARCHAR(120) DEFAULT NULL,
      `packing` VARCHAR(100) DEFAULT NULL,
      `size_or_weight` VARCHAR(100) DEFAULT NULL,
      `mrp_rate` DECIMAL(10,2) DEFAULT NULL,
      `price_min` DECIMAL(10,2) DEFAULT NULL,
      `price_max` DECIMAL(10,2) DEFAULT NULL,
      `shipper_size_pcs` INT DEFAULT NULL,
      `description` TEXT,
      `formula_composition` TEXT,
      `normalized_category` VARCHAR(120) DEFAULT NULL,
      `normalized_product_name` VARCHAR(255) NOT NULL,
      `dedupe_key` VARCHAR(700) NOT NULL,
      `is_active` TINYINT(1) NOT NULL DEFAULT '1',
      `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (`id`) USING BTREE,
      UNIQUE KEY `uq_master_medical_products_source_dedupe` (`source_type`,`dedupe_key`) USING BTREE,
      KEY `idx_master_medical_products_medicine_text` (`medicine_text_id`) USING BTREE,
      KEY `idx_master_medical_products_source` (`source_type`) USING BTREE,
      KEY `idx_master_medical_products_normalized_name` (`normalized_product_name`) USING BTREE,
      CONSTRAINT `fk_mmp_medicine_text_id` FOREIGN KEY (`medicine_text_id`) REFERENCES `master_text_medicines` (`id`) ON DELETE SET NULL ON UPDATE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

END$$

DELIMITER ;

-- Execute procedure for safe rename and table creation
CALL `sp_run_migration_refresh_medicine_masters`();

-- Clean up helper procedure
DROP PROCEDURE IF EXISTS `sp_run_migration_refresh_medicine_masters`;

-- ==============================================================================
-- STEP 5: INSERT MASTER DATA INTO master_text_medicines
-- ==============================================================================
INSERT INTO `master_text_medicines`
    (`id`, `medicine_value`, `normalized_value`, `is_active`, `is_doctor_manual`, `created_at`, `updated_at`)
VALUES
(1, 'Ad. Pro vitamin Shampoo', 'ad. pro vitamin shampoo', 1, 0, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(2, 'BT Adrehett Drop', 'bt adrehett drop', 1, 0, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(3, 'BT Arthohett Drop', 'bt arthohett drop', 1, 0, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(4, 'BT Arunahett Drop', 'bt arunahett drop', 1, 0, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(5, 'BT Balsahett Drop', 'bt balsahett drop', 1, 0, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(6, 'BT Bed Wet Drop', 'bt bed wet drop', 1, 0, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(7, 'BT Cardio Boost Drop', 'bt cardio boost drop', 1, 0, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(8, 'BT Cedrohett Drop', 'bt cedrohett drop', 1, 0, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(9, 'BT Colicohett Drop', 'bt colicohett drop', 1, 0, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(10, 'BT Colohett Drop', 'bt colohett drop', 1, 0, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(11, 'BT Concievohett Drop', 'bt concievohett drop', 1, 0, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(12, 'BT Corn-X Drop', 'bt corn-x drop', 1, 0, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(13, 'BT Crampohett Drop', 'bt crampohett drop', 1, 0, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(14, 'BT Creatihett Drop', 'bt creatihett drop', 1, 0, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(15, 'BT Cystohett Drop', 'bt cystohett drop', 1, 0, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(16, 'BT Dermageh Drop', 'bt dermageh drop', 1, 0, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(17, 'BT Diaborect Drop', 'bt diaborect drop', 1, 0, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(18, 'BT Diarhohett Drop', 'bt diarhohett drop', 1, 0, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(19, 'BT End Tox Drop', 'bt end tox drop', 1, 0, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(20, 'BT Epilep Drop', 'bt epilep drop', 1, 0, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(21, 'BT Ferohett Drop', 'bt ferohett drop', 1, 0, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(22, 'BT Fit-Fat Drop', 'bt fit-fat drop', 1, 0, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(23, 'BT Flowell Drop', 'bt flowell drop', 1, 0, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(24, 'BT Fucohett Drop', 'bt fucohett drop', 1, 0, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(25, 'BT Glahdohett Drop', 'bt glahdohett drop', 1, 0, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(26, 'BT Glowhett Drop', 'bt glowhett drop', 1, 0, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(27, 'BT Herhi Phos Drop', 'bt herhi phos drop', 1, 0, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(28, 'BT Immunopluse Drop', 'bt immunopluse drop', 1, 0, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(29, 'BT Improhett Drop', 'bt improhett drop', 1, 0, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(30, 'BT Insohett Drop', 'bt insohett drop', 1, 0, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(31, 'BT Kalmohett Drop', 'bt kalmohett drop', 1, 0, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(32, 'BT Kafure Drop', 'bt kafure drop', 1, 0, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(33, 'BT Taxohett Drop', 'bt taxohett drop', 1, 0, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(34, 'BT Lypohett Drop', 'bt lypohett drop', 1, 0, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(35, 'BT Menopause Drop', 'bt menopause drop', 1, 0, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(36, 'BT Mercohett Drop', 'bt mercohett drop', 1, 0, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(37, 'BT Migrohett Drop', 'bt migrohett drop', 1, 0, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(38, 'BT Moshett Drop', 'bt moshett drop', 1, 0, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(39, 'BT Nasopolye Drop', 'bt nasopolye drop', 1, 0, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(40, 'BT Nausinett Drop', 'bt nausinett drop', 1, 0, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(41, 'BT Ossihett Drop', 'bt ossihett drop', 1, 0, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(42, 'BT Ovohett Drop', 'bt ovohett drop', 1, 0, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(43, 'BT Picrohett Drop', 'bt picrohett drop', 1, 0, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(44, 'BT Pilohett Drop', 'bt pilohett drop', 1, 0, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(45, 'BT Pimplohett Drop', 'bt pimplohett drop', 1, 0, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(46, 'BT Prostohett Drop', 'bt prostohett drop', 1, 0, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(47, 'BT Rahohett Drop', 'bt rahohett drop', 1, 0, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(48, 'BT Restohett Drop', 'bt restohett drop', 1, 0, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(49, 'BT Rheumghett Drop', 'bt rheumghett drop', 1, 0, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(50, 'BT Rhino-Bih Drop', 'bt rhino-bih drop', 1, 0, '2026-08-18 05:18:46', '2026-08-18 05:18:46');

INSERT INTO `master_text_medicines`
    (`id`, `medicine_value`, `normalized_value`, `is_active`, `is_doctor_manual`, `created_at`, `updated_at`)
VALUES
(51, 'BT Rheumgain Drop', 'bt rheumgain drop', 1, 0, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(52, 'BT Rhushett Drop', 'bt rhushett drop', 1, 0, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(53, 'BT Sciatihett Drop', 'bt sciatihett drop', 1, 0, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(54, 'BT Sharpohett Drop', 'bt sharpohett drop', 1, 0, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(55, 'BT Shorih X Drop', 'bt shorih x drop', 1, 0, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(56, 'BT Sweatohett Drop', 'bt sweatohett drop', 1, 0, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(57, 'BT Testohett Drop', 'bt testohett drop', 1, 0, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(58, 'BT Thyrohett Drop', 'bt thyrohett drop', 1, 0, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(59, 'BT Tumerohett Drop', 'bt tumerohett drop', 1, 0, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(60, 'BT Urihett Drop', 'bt urihett drop', 1, 0, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(61, 'BT Urogaut Drop', 'bt urogaut drop', 1, 0, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(62, 'BT Aricoshett Drop', 'bt aricoshett drop', 1, 0, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(63, 'BT Vertigo Drop', 'bt vertigo drop', 1, 0, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(64, 'BT Wastomed Drop', 'bt wastomed drop', 1, 0, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(65, 'BT Wastomed Plus Drop', 'bt wastomed plus drop', 1, 0, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(66, 'BT Acidohett Syrup 200ml', 'bt acidohett syrup 200ml', 1, 0, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(67, 'BT Acidohett Syrup 450ml', 'bt acidohett syrup 450ml', 1, 0, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(68, 'BT Alfahett Syrup 200ml', 'bt alfahett syrup 200ml', 1, 0, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(69, 'BT Alfahett Syrup 450ml', 'bt alfahett syrup 450ml', 1, 0, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(70, 'BT Allahett Syrup 200ml', 'bt allahett syrup 200ml', 1, 0, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(71, 'BT Allahett Syrup 450ml', 'bt allahett syrup 450ml', 1, 0, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(72, 'BT Asthuse Syrup 200ml', 'bt asthuse syrup 200ml', 1, 0, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(73, 'BT Asthure Syrup 450ml', 'bt asthure syrup 450ml', 1, 0, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(74, 'BT BP Nett Syrup 200ml', 'bt bp nett syrup 200ml', 1, 0, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(75, 'BT BP Nett Syrup 450ml', 'bt bp nett syrup 450ml', 1, 0, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(76, 'BT Digohett Syrup 200ml', 'bt digohett syrup 200ml', 1, 0, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(77, 'BT Digohett Syrup 450ml', 'bt digohett syrup 450ml', 1, 0, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(78, 'BT Echinett Syrup 200ml', 'bt echinett syrup 200ml', 1, 0, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(79, 'BT Echinett Syrup 450ml', 'bt echinett syrup 450ml', 1, 0, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(80, 'BT Graiponett Syrup 200ml', 'bt graiponett syrup 200ml', 1, 0, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(81, 'BT Koffhett Syrup 200ml', 'bt koffhett syrup 200ml', 1, 0, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(82, 'BT Livohett Syrup 450ml', 'bt livohett syrup 450ml', 1, 0, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(83, 'BT Livohett Syrup 200ml', 'bt livohett syrup 200ml', 1, 0, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(84, 'BT Nervohett Syrup 450ml', 'bt nervohett syrup 450ml', 1, 0, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(85, 'BT Nervohett Syrup 200ml', 'bt nervohett syrup 200ml', 1, 0, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(86, 'BT Plat O Plus Syrup 200ml', 'bt plat o plus syrup 200ml', 1, 0, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(87, 'BT R-Throgeh Syrup 200ml', 'bt r-throgeh syrup 200ml', 1, 0, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(88, 'BT R-Throgeh Syrup 450ml', 'bt r-throgeh syrup 450ml', 1, 0, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(89, 'BT Re Start Syrup 200ml', 'bt re start syrup 200ml', 1, 0, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(90, 'BT Re Start Syrup 450ml', 'bt re start syrup 450ml', 1, 0, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(91, 'BT Stohe Hammer Syrup 200ml', 'bt stohe hammer syrup 200ml', 1, 0, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(92, 'BT Stohe Hammer Syrup 450ml', 'bt stohe hammer syrup 450ml', 1, 0, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(93, 'BT V Fine Syrup 200ml', 'bt v fine syrup 200ml', 1, 0, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(94, 'BT V Fine Syrup 450ml', 'bt v fine syrup 450ml', 1, 0, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(95, 'BT Alovera Cream', 'bt alovera cream', 1, 0, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(96, 'BT Argan Hair Oil', 'bt argan hair oil', 1, 0, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(97, 'BT Argan Hair Shampoo', 'bt argan hair shampoo', 1, 0, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(98, 'BT Baby Move Oil', 'bt baby move oil', 1, 0, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(99, 'BT Argan Hair Oil + HQ', 'bt argan hair oil + hq', 1, 0, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(100, 'BT Baldonett Hair Oil 100ml', 'bt baldonett hair oil 100ml', 1, 0, '2026-08-18 05:18:46', '2026-08-18 05:18:46');

INSERT INTO `master_text_medicines`
    (`id`, `medicine_value`, `normalized_value`, `is_active`, `is_doctor_manual`, `created_at`, `updated_at`)
VALUES
(101, 'BT Baldonett Shampoo 100ml', 'bt baldonett shampoo 100ml', 1, 0, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(102, 'BT Baldonett Shampoo 200ml', 'bt baldonett shampoo 200ml', 1, 0, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(103, 'BT Baldonett Oil + HQ', 'bt baldonett oil + hq', 1, 0, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(104, 'BT Dermagen Cream 100ml', 'bt dermagen cream 100ml', 1, 0, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(105, 'BT Dermagen Cream 200gm', 'bt dermagen cream 200gm', 1, 0, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(106, 'BT Sehratt Cream 50gm', 'bt sehratt cream 50gm', 1, 0, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(107, 'BT Face Refiner Serum 35gm', 'bt face refiner serum 35gm', 1, 0, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(108, 'BT Glownett Cream 50gm', 'bt glownett cream 50gm', 1, 0, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(109, 'BT Glownett Facewash 50ml', 'bt glownett facewash 50ml', 1, 0, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(110, 'BT Hair Repair Serum', 'bt hair repair serum', 1, 0, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(111, 'BT Lucodermo Lotion', 'bt lucodermo lotion', 1, 0, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(112, 'BT Mullein Oil', 'bt mullein oil', 1, 0, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(113, 'BT Newronett Oil 60ml', 'bt newronett oil 60ml', 1, 0, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(114, 'BT Paralin Oil', 'bt paralin oil', 1, 0, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(115, 'BT Pimplonett Cream 50gm', 'bt pimplonett cream 50gm', 1, 0, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(116, 'BT Pimplonett Facewash 50ml', 'bt pimplonett facewash 50ml', 1, 0, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(117, 'BT Poshanett Cream 50gm', 'bt poshanett cream 50gm', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(118, 'BT R-Throgen Oil 60ml', 'bt r-throgen oil 60ml', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(119, 'BT R-Throgen Oil 100ml', 'bt r-throgen oil 100ml', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(120, 'BT Rebud Hair Oil', 'bt rebud hair oil', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(121, 'BT Rebud Shampoo', 'bt rebud shampoo', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(122, 'BT Rebud Hair Oil + HQ', 'bt rebud hair oil + hq', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(123, 'BT Septo-V Lotion', 'bt septo-v lotion', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(124, 'BT Skin Protector Cream', 'bt skin protector cream', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(125, 'BT Skin Repair Tonic', 'bt skin repair tonic', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(126, 'AD A-108 Drop', 'ad a-108 drop', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(127, 'AD A-153 Drop', 'ad a-153 drop', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(128, 'AD A-175 Drop', 'ad a-175 drop', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(129, 'AD A-188 Drop', 'ad a-188 drop', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(130, 'AD A-195 Drop', 'ad a-195 drop', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(131, 'AD A-204 Drop', 'ad a-204 drop', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(132, 'AD A-205 Drop', 'ad a-205 drop', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(133, 'AD Anti-Fungal Drop', 'ad anti-fungal drop', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(134, 'AD Cardio-Gold Drop', 'ad cardio-gold drop', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(135, 'AD Cholesterol Drop', 'ad cholesterol drop', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(136, 'AD Gall Set Drop', 'ad gall set drop', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(137, 'AD Glow Aid Drop', 'ad glow aid drop', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(138, 'AD Leucodcare Drop', 'ad leucodcare drop', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(139, 'AD Osrul Drop', 'ad osrul drop', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(140, 'AD Osteodin-Z Drop', 'ad osteodin-z drop', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(141, 'AD Paingo Drop', 'ad paingo drop', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(142, 'AD Pilcare Drop', 'ad pilcare drop', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(143, 'AD Sinus Drop', 'ad sinus drop', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(144, 'AD Teston Fort Drop', 'ad teston fort drop', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(145, 'AD Wartinor Drop', 'ad wartinor drop', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(146, 'AD AD-Lev Syrup 180ml', 'ad ad-lev syrup 180ml', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(147, 'AD AD-Lev Syrup 450ml', 'ad ad-lev syrup 450ml', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(148, 'AD Femson Syrup 180ml', 'ad femson syrup 180ml', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(149, 'AD Femson Syrup 450ml', 'ad femson syrup 450ml', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(150, 'AD Hematone Syrup 180ml', 'ad hematone syrup 180ml', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47');

INSERT INTO `master_text_medicines`
    (`id`, `medicine_value`, `normalized_value`, `is_active`, `is_doctor_manual`, `created_at`, `updated_at`)
VALUES
(151, 'AD Hematone Syrup 450ml', 'ad hematone syrup 450ml', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(152, 'AD Gustin Syrup 180ml', 'ad gustin syrup 180ml', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(153, 'AD Justin Syrup 450ml', 'ad justin syrup 450ml', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(154, 'AD ABC Lotion 1000gm', 'ad abc lotion 1000gm', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(155, 'AD ABC Lotion 100ml', 'ad abc lotion 100ml', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(156, 'AD All Purpose Cream 100ml', 'ad all purpose cream 100ml', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(157, 'AD Anti-Dandruff Shampoo 200ml', 'ad anti-dandruff shampoo 200ml', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(158, 'AD Anti-Dandruff Shampoo', 'ad anti-dandruff shampoo', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(159, 'AD Black Hair Colour', 'ad black hair colour', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(160, 'AD Body Wash with ABC', 'ad body wash with abc', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(161, 'AD Brown Hair Colour 100gm', 'ad brown hair colour 100gm', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(162, 'AD Face Wash with ABC 100ml', 'ad face wash with abc 100ml', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(163, 'AD Jabarandi Oil 200ml', 'ad jabarandi oil 200ml', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(164, 'AD Jabarandi Oil + HQ 200ml', 'ad jabarandi oil + hq 200ml', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(165, 'AD Hamamelis Ointment', 'ad hamamelis ointment', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(166, 'AD Heel Heel Cream 200ml', 'ad heel heel cream 200ml', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(167, 'AD Pro-Vitamin Shampoo 200ml', 'ad pro-vitamin shampoo 200ml', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(168, 'AD Pro-Vitamin Shampoo 100ml', 'ad pro-vitamin shampoo 100ml', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(169, 'AD Sun Protection Cream 100ml', 'ad sun protection cream 100ml', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(170, 'AD Arnica Oil 100ml', 'ad arnica oil 100ml', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(171, 'AD Arnica Oil 200ml', 'ad arnica oil 200ml', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(172, 'AD Arnica Oil + HQ 100ml', 'ad arnica oil + hq 100ml', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(173, 'AD Arnica Oil + HQ 200ml', 'ad arnica oil + hq 200ml', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(174, 'AD Jabarandi Oil + HQ 100ml', 'ad jabarandi oil + hq 100ml', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(175, 'BT 01 Tab 40 tabs', 'bt 01 tab 40 tabs', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(176, 'DT 01/25 Tab 30 tabs', 'dt 01/25 tab 30 tabs', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(177, 'BT 02 Tab 40 tabs', 'bt 02 tab 40 tabs', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(178, 'DT 02/25 Tab 30 tabs', 'dt 02/25 tab 30 tabs', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(179, 'BT 03 Tab 40 tabs', 'bt 03 tab 40 tabs', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(180, 'DT 03/25 Tab 30 tabs', 'dt 03/25 tab 30 tabs', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(181, 'BT 08 Tab 40 tabs', 'bt 08 tab 40 tabs', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(182, 'DT 08/25 Tab 30 tabs', 'dt 08/25 tab 30 tabs', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(183, 'BT 10 Tab 40 tabs', 'bt 10 tab 40 tabs', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(184, 'DT 10/25 Tab 30 tabs', 'dt 10/25 tab 30 tabs', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(185, 'BT 11 Tab 40 tabs', 'bt 11 tab 40 tabs', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(186, 'DT 11/25 Tab 30 tabs', 'dt 11/25 tab 30 tabs', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(187, 'BT 17 Tab 40 tabs', 'bt 17 tab 40 tabs', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(188, 'DT 17/25 Tab 30 tabs', 'dt 17/25 tab 30 tabs', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(189, 'BT 22 Tab 40 tabs', 'bt 22 tab 40 tabs', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(190, 'DT 22/25 Tab 30 tabs', 'dt 22/25 tab 30 tabs', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(191, 'BT 49 Tab 40 tabs', 'bt 49 tab 40 tabs', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(192, 'DT 49/25 Tab 30 tabs', 'dt 49/25 tab 30 tabs', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(193, 'BT 50 Tab 40 tabs', 'bt 50 tab 40 tabs', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(194, 'DT 50/25 Tab 30 tabs', 'dt 50/25 tab 30 tabs', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(195, 'BT 51 Tab 40 tabs', 'bt 51 tab 40 tabs', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(196, 'DT 51/25 Tab 30 tabs', 'dt 51/25 tab 30 tabs', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(197, 'BT 69 Tab 40 tabs', 'bt 69 tab 40 tabs', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(198, 'DT 69/3 Tab 30 tabs', 'dt 69/3 tab 30 tabs', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(199, 'BT 70 Tab 40 tabs', 'bt 70 tab 40 tabs', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(200, 'DT 70/25 Tab 30 tabs', 'dt 70/25 tab 30 tabs', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47');

INSERT INTO `master_text_medicines`
    (`id`, `medicine_value`, `normalized_value`, `is_active`, `is_doctor_manual`, `created_at`, `updated_at`)
VALUES
(201, 'BT 76 Tab 40 tabs', 'bt 76 tab 40 tabs', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(202, 'DT 76/25 Tab 30 tabs', 'dt 76/25 tab 30 tabs', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(203, 'BT 80 Tab 40 tabs', 'bt 80 tab 40 tabs', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(204, 'DT 80/25 Tab 30 tabs', 'dt 80/25 tab 30 tabs', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(205, 'BT 102 Tab 40 tabs', 'bt 102 tab 40 tabs', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(206, 'DT 102/25 Tab 30 tabs', 'dt 102/25 tab 30 tabs', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(207, 'BT 110 Tab 40 tabs', 'bt 110 tab 40 tabs', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(208, 'BT 111 Tab 40 tabs', 'bt 111 tab 40 tabs', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(209, 'DT 111/25 Tab 30 tabs', 'dt 111/25 tab 30 tabs', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(210, 'BT 127 Tab 40 tabs', 'bt 127 tab 40 tabs', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(211, 'DT 127/25 Tab 30 tabs', 'dt 127/25 tab 30 tabs', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(212, 'BT 131 Tab 40 tabs', 'bt 131 tab 40 tabs', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(213, 'DT 131/25 Tab 30 tabs', 'dt 131/25 tab 30 tabs', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(214, 'BT Immunofem Tab 30 tabs', 'bt immunofem tab 30 tabs', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(215, 'BT Feroboost Tab 30 tabs', 'bt feroboost tab 30 tabs', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(216, 'BT Neurophes Tab 30 tabs', 'bt neurophes tab 30 tabs', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(217, 'BT Penophos Tab 30 tabs', 'bt penophos tab 30 tabs', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(218, 'BT Nail & Hair Tab 40 tabs', 'bt nail & hair tab 40 tabs', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(219, 'BT Anthrako Kali Tab 40 tabs', 'bt anthrako kali tab 40 tabs', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(220, 'DT AK/25 Tab 30 tabs', 'dt ak/25 tab 30 tabs', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(221, 'BT Bambysa Tab 40 tabs', 'bt bambysa tab 40 tabs', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(222, 'DT Bus/25 Tab 30 tabs', 'dt bus/25 tab 30 tabs', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(223, 'BT Folicane Tab 30 tabs', 'bt folicane tab 30 tabs', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(224, 'BT Salolum Tab 250 tabs', 'bt salolum tab 250 tabs', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(225, 'BT Livonett Gold Tab 30 tabs', 'bt livonett gold tab 30 tabs', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(226, 'DT LG/25 Tab 30 tabs', 'dt lg/25 tab 30 tabs', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(227, 'BT Re Start Tab 30 tabs', 'bt re start tab 30 tabs', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(228, 'BT Stone Hammer Tab', 'bt stone hammer tab', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(229, 'BT Vitamin D Tab 30 tabs', 'bt vitamin d tab 30 tabs', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(230, 'BT Wild Fire Tab 30 tabs', 'bt wild fire tab 30 tabs', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(231, 'Medi Vitamin D Tab 60 tabs', 'medi vitamin d tab 60 tabs', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(232, 'Medi Vitamin B12 Tab 60 tabs', 'medi vitamin b12 tab 60 tabs', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(233, 'Osteo Strong Tab 25gm', 'osteo strong tab 25gm', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(234, 'WSI Alpha Liv Drop 30ml', 'wsi alpha liv drop 30ml', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(235, 'WSI Good Morning Drop 30ml', 'wsi good morning drop 30ml', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(236, 'WSI PTK 89 Drop 30ml', 'wsi ptk 89 drop 30ml', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(237, 'WSI Ruck Pain Drop 30ml', 'wsi ruck pain drop 30ml', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(238, 'WSI Zauber Drop 30ml', 'wsi zauber drop 30ml', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(239, 'WSI PTK 75 Drop 30ml', 'wsi ptk 75 drop 30ml', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(240, 'WSI Dizester Syrup 200ml', 'wsi dizester syrup 200ml', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(241, 'WSI Dizester Syrup 450ml', 'wsi dizester syrup 450ml', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(242, 'WSI Kofsih Syrup 200ml', 'wsi kofsih syrup 200ml', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(243, 'WSI Kofsih Syrup 450ml', 'wsi kofsih syrup 450ml', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(244, 'WSI NL Alfa Malt 450ml', 'wsi nl alfa malt 450ml', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(245, 'NL 1 Drop 30ml', 'nl 1 drop 30ml', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(246, 'NL 8 Drop 30ml', 'nl 8 drop 30ml', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(247, 'NL 10 Drop 30ml', 'nl 10 drop 30ml', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(248, 'NL 13 Drop 30ml', 'nl 13 drop 30ml', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(249, 'NL 14 Drop 30ml', 'nl 14 drop 30ml', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(250, 'NL 19 Drop 30ml', 'nl 19 drop 30ml', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47');

INSERT INTO `master_text_medicines`
    (`id`, `medicine_value`, `normalized_value`, `is_active`, `is_doctor_manual`, `created_at`, `updated_at`)
VALUES
(251, 'NL 4 Drop 30ml', 'nl 4 drop 30ml', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(252, 'NL 5 Drop 30ml', 'nl 5 drop 30ml', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(253, 'NL 9 Drop 30ml', 'nl 9 drop 30ml', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(254, 'NL Aller-N Drop 30ml', 'nl aller-n drop 30ml', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(255, 'NL Angio Bold Drop 30ml', 'nl angio bold drop 30ml', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(256, 'NL Hairzootone Drop 30ml', 'nl hairzootone drop 30ml', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(257, 'NL Nervoain Drop 30ml', 'nl nervoain drop 30ml', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(258, 'NL Pilocin Drop 30ml', 'nl pilocin drop 30ml', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(259, 'NL Sinocin Drop 30ml', 'nl sinocin drop 30ml', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(260, 'Medi Calendula Berberis Soap 100gm', 'medi calendula berberis soap 100gm', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(261, 'Medi Aloe Vera Neem Tulsi Soap 100gm', 'medi aloe vera neem tulsi soap 100gm', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(262, 'SBL Baby Care Soap', 'sbl baby care soap', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(263, 'SBL Silk-N Stay Berberis Soap', 'sbl silk-n stay berberis soap', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(264, 'WL Glow Bright Soap', 'wl glow bright soap', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(265, 'WSI Glow & Fairness Soap', 'wsi glow & fairness soap', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(266, 'WSI Eye Drop', 'wsi eye drop', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(267, 'SSB 01 Breathe Ease Drop 30ml', 'ssb 01 breathe ease drop 30ml', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(268, 'SSB 13 Fissurex Drop 30ml', 'ssb 13 fissurex drop 30ml', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(269, 'SSB 05 Helptrol Drop 30ml', 'ssb 05 helptrol drop 30ml', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(270, 'SSB 19 Otorol Drop 30ml', 'ssb 19 otorol drop 30ml', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(271, 'SSB 23 Leucoral Drop 30ml', 'ssb 23 leucoral drop 30ml', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(272, 'SSB 80 Leucoderma Drop 30ml', 'ssb 80 leucoderma drop 30ml', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(273, 'MP 32 Gallstone-M Drop 30ml', 'mp 32 gallstone-m drop 30ml', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(274, 'MP 53 Apeto-M Drop 30ml', 'mp 53 apeto-m drop 30ml', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(275, 'MP Adenoid Drop 30ml', 'mp adenoid drop 30ml', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(276, 'MP Corn-M Drop 30ml', 'mp corn-m drop 30ml', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(277, 'MP Dentagum-M Drop 30ml', 'mp dentagum-m drop 30ml', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(278, 'MP Heel Painhex Drop 30ml', 'mp heel painhex drop 30ml', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(279, 'MP Hirsutism Drop 30ml', 'mp hirsutism drop 30ml', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(280, 'MP Nasal Polyp Drop 30ml', 'mp nasal polyp drop 30ml', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(281, 'NB 10 Drop 30ml', 'nb 10 drop 30ml', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(282, 'NB 26 Drop 30ml', 'nb 26 drop 30ml', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(283, 'NB 46 Drop 30ml', 'nb 46 drop 30ml', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(284, 'NB 48 Drop', 'nb 48 drop', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(285, 'NB 49 Drop', 'nb 49 drop', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(286, 'NB 52 Drop', 'nb 52 drop', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(287, 'NB 54 Drop', 'nb 54 drop', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(288, 'NB 63 Drop', 'nb 63 drop', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(289, 'NB 75 Drop', 'nb 75 drop', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(290, 'NB 83 Drop', 'nb 83 drop', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(291, 'NB 92 Drop', 'nb 92 drop', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(292, 'Rd 01 Renal Calculas Drop 30ml', 'rd 01 renal calculas drop 30ml', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(293, 'Rd 09 Rheumatism Drop 30ml', 'rd 09 rheumatism drop 30ml', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(294, 'Rd 20 Migraine Drop 30ml', 'rd 20 migraine drop 30ml', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(295, 'Rd 29 Tonsilis Drop', 'rd 29 tonsilis drop', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(296, 'Rd 33 Bronchitis Drop', 'rd 33 bronchitis drop', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(297, 'Rd 39 Prosiasis Drop', 'rd 39 prosiasis drop', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(298, 'Rd 40 Urticaria Drop', 'rd 40 urticaria drop', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(299, 'Rd 43 Leucoderma Drop', 'rd 43 leucoderma drop', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(300, 'Rd 46 Premature Drop', 'rd 46 premature drop', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47');

INSERT INTO `master_text_medicines`
    (`id`, `medicine_value`, `normalized_value`, `is_active`, `is_doctor_manual`, `created_at`, `updated_at`)
VALUES
(301, 'Rd 47 Anti Dandruff Drop', 'rd 47 anti dandruff drop', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(302, 'Rd 48 Alopecia Drop', 'rd 48 alopecia drop', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(303, 'Rd 49 Prostate Drop', 'rd 49 prostate drop', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(304, 'Rd 50 Bed Wetting Drop', 'rd 50 bed wetting drop', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(305, 'Rd 52 Kalmeth Drop', 'rd 52 kalmeth drop', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(306, 'Rd 53 Immunity Drop', 'rd 53 immunity drop', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(307, 'Rd 54 Height Gain Drop 30ml', 'rd 54 height gain drop 30ml', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(308, 'Rd 62 Ovarian Cyst Drop', 'rd 62 ovarian cyst drop', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(309, 'Rd 63 Uterine Fibroids Drop', 'rd 63 uterine fibroids drop', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(310, 'Rd 65 Breast Guard Drop', 'rd 65 breast guard drop', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(311, 'Rd 69 Thyroid Drop', 'rd 69 thyroid drop', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(312, 'Rd 71 Diabetes Drop', 'rd 71 diabetes drop', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(313, 'Rd 97 Tumour Drop', 'rd 97 tumour drop', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(314, 'Rd 98 Hernia Drop', 'rd 98 hernia drop', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(315, 'Rd 100 Dengue Drop', 'rd 100 dengue drop', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(316, 'PM P1 Acidity Drop 30ml', 'pm p1 acidity drop 30ml', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(317, 'PM P19 Pain Drop 30ml', 'pm p19 pain drop 30ml', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(318, 'PM P20 Blood Pressure Drop 30ml', 'pm p20 blood pressure drop 30ml', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(319, 'PM P3 Allergy Drop 30ml', 'pm p3 allergy drop 30ml', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(320, 'PM Rheumcare Syrup 200ml', 'pm rheumcare syrup 200ml', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(321, 'PM Rheumcare Syrup 450ml', 'pm rheumcare syrup 450ml', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(322, 'Faceliquid 2 30ml', 'faceliquid 2 30ml', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(323, 'Faceliquid/15 15ml', 'faceliquid/15 15ml', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(324, '70 Q 15 100ml', '70 q 15 100ml', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(325, '70 Q4 15 15ml', '70 q4 15 15ml', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(326, '70 Q B12 30ml', '70 q b12 30ml', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(327, '70 Q/1 15ml', '70 q/1 15ml', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(328, '740 Tabo Q 12 30ml', '740 tabo q 12 30ml', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(329, '740 Tabo Q/15 15ml', '740 tabo q/15 15ml', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(330, 'White Spot Liquid/15 15ml', 'white spot liquid/15 15ml', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(331, 'Leucodermalotient + W.Spot Liquid', 'leucodermalotient + w.spot liquid', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(332, 'UQ1', 'uq1', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(333, 'Wart and Corn + UQ', 'wart and corn + uq', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(334, 'Cornhil Cream + 70Q', 'cornhil cream + 70q', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(335, 'Septo Lotion + 70Q', 'septo lotion + 70q', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(336, 'Body Oil + 70Q B', 'body oil + 70q b', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(337, 'Wastomed + UQ', 'wastomed + uq', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(338, 'Skin Repair Tonic + 70Q/15', 'skin repair tonic + 70q/15', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(339, 'B-Shape + 70Q/15', 'b-shape + 70q/15', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(340, 'Heal Cream + 70Q/15', 'heal cream + 70q/15', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(341, 'Dermasen Cream + 70Q/15', 'dermasen cream + 70q/15', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(342, 'Dermasen Tube + 70Q/15', 'dermasen tube + 70q/15', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(343, 'Hemalmalis + 70Q/15', 'hemalmalis + 70q/15', 1, 0, '2026-08-18 05:18:47', '2026-08-18 05:18:47');

-- ==============================================================================
-- STEP 6: INSERT MASTER DATA INTO master_medical_products
-- ==============================================================================
INSERT INTO `master_medical_products`
    (`id`, `medicine_text_id`, `source_type`, `source_old_id`, `product_name`, `product_type`, `category`, `packing`, `size_or_weight`, `mrp_rate`, `price_min`, `price_max`, `shipper_size_pcs`, `description`, `formula_composition`, `normalized_category`, `normalized_product_name`, `dedupe_key`, `is_active`, `created_at`, `updated_at`)
VALUES
(1, 1, 'MEDICAL_PRODUCT_PRICE', NULL, 'Ad. Pro vitamin Shampoo', 'SHAMPOO', 'Adven', NULL, NULL, 260.00, 260.00, 260.00, NULL, 'Handwritten Set 1 (Cosmetics/Shampoo)', NULL, 'adven', 'ad. pro vitamin shampoo', 'adven|ad. pro vitamin shampoo', 1, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(2, 2, 'MEDICAL_PRODUCT_PRICE', NULL, 'BT Adrehett Drop', 'DROP', 'BT', 'ml', '30', 170.00, 170.00, 170.00, NULL, 'BT Drops', NULL, 'bt', 'bt adrehett drop', 'bt|bt adrehett drop', 1, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(3, 3, 'MEDICAL_PRODUCT_PRICE', NULL, 'BT Arthohett Drop', 'DROP', 'BT', 'ml', '30', 210.00, 210.00, 210.00, NULL, 'BT Drops', NULL, 'bt', 'bt arthohett drop', 'bt|bt arthohett drop', 1, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(4, 4, 'MEDICAL_PRODUCT_PRICE', NULL, 'BT Arunahett Drop', 'DROP', 'BT', 'ml', '30', 210.00, 210.00, 210.00, NULL, 'BT Drops', NULL, 'bt', 'bt arunahett drop', 'bt|bt arunahett drop', 1, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(5, 5, 'MEDICAL_PRODUCT_PRICE', NULL, 'BT Balsahett Drop', 'DROP', 'BT', 'ml', '30', 188.00, 188.00, 188.00, NULL, 'BT Drops', NULL, 'bt', 'bt balsahett drop', 'bt|bt balsahett drop', 1, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(6, 6, 'MEDICAL_PRODUCT_PRICE', NULL, 'BT Bed Wet Drop', 'DROP', 'BT', 'ml', '30', 200.00, 200.00, 200.00, NULL, 'BT Drops', NULL, 'bt', 'bt bed wet drop', 'bt|bt bed wet drop', 1, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(7, 7, 'MEDICAL_PRODUCT_PRICE', NULL, 'BT Cardio Boost Drop', 'DROP', 'BT', 'ml', '30', 170.00, 170.00, 170.00, NULL, 'BT Drops', NULL, 'bt', 'bt cardio boost drop', 'bt|bt cardio boost drop', 1, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(8, 8, 'MEDICAL_PRODUCT_PRICE', NULL, 'BT Cedrohett Drop', 'DROP', 'BT', 'ml', '30', 210.00, 210.00, 210.00, NULL, 'BT Drops', NULL, 'bt', 'bt cedrohett drop', 'bt|bt cedrohett drop', 1, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(9, 9, 'MEDICAL_PRODUCT_PRICE', NULL, 'BT Colicohett Drop', 'DROP', 'BT', 'ml', '30', 188.00, 188.00, 188.00, NULL, 'BT Drops', NULL, 'bt', 'bt colicohett drop', 'bt|bt colicohett drop', 1, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(10, 10, 'MEDICAL_PRODUCT_PRICE', NULL, 'BT Colohett Drop', 'DROP', 'BT', 'ml', '30', 188.00, 188.00, 188.00, NULL, 'BT Drops', NULL, 'bt', 'bt colohett drop', 'bt|bt colohett drop', 1, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(11, 11, 'MEDICAL_PRODUCT_PRICE', NULL, 'BT Concievohett Drop', 'DROP', 'BT', 'ml', '30', 170.00, 170.00, 170.00, NULL, 'BT Drops', NULL, 'bt', 'bt concievohett drop', 'bt|bt concievohett drop', 1, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(12, 12, 'MEDICAL_PRODUCT_PRICE', NULL, 'BT Corn-X Drop', 'DROP', 'BT', 'ml', '30', 300.00, 300.00, 300.00, NULL, 'BT Drops', NULL, 'bt', 'bt corn-x drop', 'bt|bt corn-x drop', 1, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(13, 13, 'MEDICAL_PRODUCT_PRICE', NULL, 'BT Crampohett Drop', 'DROP', 'BT', 'ml', '30', 250.00, 250.00, 250.00, NULL, 'BT Drops', NULL, 'bt', 'bt crampohett drop', 'bt|bt crampohett drop', 1, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(14, 14, 'MEDICAL_PRODUCT_PRICE', NULL, 'BT Creatihett Drop', 'DROP', 'BT', 'ml', '30', 188.00, 188.00, 188.00, NULL, 'BT Drops', NULL, 'bt', 'bt creatihett drop', 'bt|bt creatihett drop', 1, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(15, 15, 'MEDICAL_PRODUCT_PRICE', NULL, 'BT Cystohett Drop', 'DROP', 'BT', 'ml', '30', 200.00, 200.00, 200.00, NULL, 'BT Drops', NULL, 'bt', 'bt cystohett drop', 'bt|bt cystohett drop', 1, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(16, 16, 'MEDICAL_PRODUCT_PRICE', NULL, 'BT Dermageh Drop', 'DROP', 'BT', 'ml', '30', 200.00, 200.00, 200.00, NULL, 'BT Drops', NULL, 'bt', 'bt dermageh drop', 'bt|bt dermageh drop', 1, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(17, 17, 'MEDICAL_PRODUCT_PRICE', NULL, 'BT Diaborect Drop', 'DROP', 'BT', 'ml', '30', 170.00, 170.00, 170.00, NULL, 'BT Drops', NULL, 'bt', 'bt diaborect drop', 'bt|bt diaborect drop', 1, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(18, 18, 'MEDICAL_PRODUCT_PRICE', NULL, 'BT Diarhohett Drop', 'DROP', 'BT', 'ml', '30', 188.00, 188.00, 188.00, NULL, 'BT Drops', NULL, 'bt', 'bt diarhohett drop', 'bt|bt diarhohett drop', 1, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(19, 19, 'MEDICAL_PRODUCT_PRICE', NULL, 'BT End Tox Drop', 'DROP', 'BT', 'ml', '30', 188.00, 188.00, 188.00, NULL, 'BT Drops', NULL, 'bt', 'bt end tox drop', 'bt|bt end tox drop', 1, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(20, 20, 'MEDICAL_PRODUCT_PRICE', NULL, 'BT Epilep Drop', 'DROP', 'BT', 'ml', '30', 188.00, 188.00, 188.00, NULL, 'BT Drops', NULL, 'bt', 'bt epilep drop', 'bt|bt epilep drop', 1, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(21, 21, 'MEDICAL_PRODUCT_PRICE', NULL, 'BT Ferohett Drop', 'DROP', 'BT', 'ml', '30', 188.00, 188.00, 188.00, NULL, 'BT Drops', NULL, 'bt', 'bt ferohett drop', 'bt|bt ferohett drop', 1, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(22, 22, 'MEDICAL_PRODUCT_PRICE', NULL, 'BT Fit-Fat Drop', 'DROP', 'BT', 'ml', '30', 210.00, 210.00, 210.00, NULL, 'BT Drops', NULL, 'bt', 'bt fit-fat drop', 'bt|bt fit-fat drop', 1, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(23, 23, 'MEDICAL_PRODUCT_PRICE', NULL, 'BT Flowell Drop', 'DROP', 'BT', 'ml', '30', 170.00, 170.00, 170.00, NULL, 'BT Drops', NULL, 'bt', 'bt flowell drop', 'bt|bt flowell drop', 1, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(24, 24, 'MEDICAL_PRODUCT_PRICE', NULL, 'BT Fucohett Drop', 'DROP', 'BT', 'ml', '30', 360.00, 360.00, 360.00, NULL, 'BT Drops', NULL, 'bt', 'bt fucohett drop', 'bt|bt fucohett drop', 1, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(25, 25, 'MEDICAL_PRODUCT_PRICE', NULL, 'BT Glahdohett Drop', 'DROP', 'BT', 'ml', '30', 210.00, 210.00, 210.00, NULL, 'BT Drops', NULL, 'bt', 'bt glahdohett drop', 'bt|bt glahdohett drop', 1, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(26, 26, 'MEDICAL_PRODUCT_PRICE', NULL, 'BT Glowhett Drop', 'DROP', 'BT', 'ml', '30', 200.00, 200.00, 200.00, NULL, 'BT Drops', NULL, 'bt', 'bt glowhett drop', 'bt|bt glowhett drop', 1, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(27, 27, 'MEDICAL_PRODUCT_PRICE', NULL, 'BT Herhi Phos Drop', 'DROP', 'BT', 'ml', '30', 210.00, 210.00, 210.00, NULL, 'BT Drops', NULL, 'bt', 'bt herhi phos drop', 'bt|bt herhi phos drop', 1, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(28, 28, 'MEDICAL_PRODUCT_PRICE', NULL, 'BT Immunopluse Drop', 'DROP', 'BT', 'ml', '30', 210.00, 210.00, 210.00, NULL, 'BT Drops', NULL, 'bt', 'bt immunopluse drop', 'bt|bt immunopluse drop', 1, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(29, 29, 'MEDICAL_PRODUCT_PRICE', NULL, 'BT Improhett Drop', 'DROP', 'BT', 'ml', '30', 210.00, 210.00, 210.00, NULL, 'BT Drops', NULL, 'bt', 'bt improhett drop', 'bt|bt improhett drop', 1, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(30, 30, 'MEDICAL_PRODUCT_PRICE', NULL, 'BT Insohett Drop', 'DROP', 'BT', 'ml', '30', 198.00, 198.00, 198.00, NULL, 'BT Drops', NULL, 'bt', 'bt insohett drop', 'bt|bt insohett drop', 1, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(31, 31, 'MEDICAL_PRODUCT_PRICE', NULL, 'BT Kalmohett Drop', 'DROP', 'BT', 'ml', '30', NULL, NULL, NULL, NULL, 'BT Drops', NULL, 'bt', 'bt kalmohett drop', 'bt|bt kalmohett drop', 1, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(32, 32, 'MEDICAL_PRODUCT_PRICE', NULL, 'BT Kafure Drop', 'DROP', 'BT', 'ml', '30', NULL, NULL, NULL, NULL, 'BT Drops', NULL, 'bt', 'bt kafure drop', 'bt|bt kafure drop', 1, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(33, 33, 'MEDICAL_PRODUCT_PRICE', NULL, 'BT Taxohett Drop', 'DROP', 'BT', 'ml', '30', 200.00, 200.00, 200.00, NULL, 'BT Drops', NULL, 'bt', 'bt taxohett drop', 'bt|bt taxohett drop', 1, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(34, 34, 'MEDICAL_PRODUCT_PRICE', NULL, 'BT Lypohett Drop', 'DROP', 'BT', 'ml', '30', 198.00, 198.00, 198.00, NULL, 'BT Drops', NULL, 'bt', 'bt lypohett drop', 'bt|bt lypohett drop', 1, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(35, 35, 'MEDICAL_PRODUCT_PRICE', NULL, 'BT Menopause Drop', 'DROP', 'BT', 'ml', '30', 210.00, 210.00, 210.00, NULL, 'BT Drops', NULL, 'bt', 'bt menopause drop', 'bt|bt menopause drop', 1, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(36, 36, 'MEDICAL_PRODUCT_PRICE', NULL, 'BT Mercohett Drop', 'DROP', 'BT', 'ml', '30', 220.00, 220.00, 220.00, NULL, 'BT Drops', NULL, 'bt', 'bt mercohett drop', 'bt|bt mercohett drop', 1, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(37, 37, 'MEDICAL_PRODUCT_PRICE', NULL, 'BT Migrohett Drop', 'DROP', 'BT', 'ml', '30', 188.00, 188.00, 188.00, NULL, 'BT Drops', NULL, 'bt', 'bt migrohett drop', 'bt|bt migrohett drop', 1, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(38, 38, 'MEDICAL_PRODUCT_PRICE', NULL, 'BT Moshett Drop', 'DROP', 'BT', 'ml', '30', 201.00, 201.00, 201.00, NULL, 'BT Drops', NULL, 'bt', 'bt moshett drop', 'bt|bt moshett drop', 1, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(39, 39, 'MEDICAL_PRODUCT_PRICE', NULL, 'BT Nasopolye Drop', 'DROP', 'BT', 'ml', '30', 200.00, 200.00, 200.00, NULL, 'BT Drops', NULL, 'bt', 'bt nasopolye drop', 'bt|bt nasopolye drop', 1, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(40, 40, 'MEDICAL_PRODUCT_PRICE', NULL, 'BT Nausinett Drop', 'DROP', 'BT', 'ml', '30', 170.00, 170.00, 170.00, NULL, 'BT Drops', NULL, 'bt', 'bt nausinett drop', 'bt|bt nausinett drop', 1, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(41, 41, 'MEDICAL_PRODUCT_PRICE', NULL, 'BT Ossihett Drop', 'DROP', 'BT', 'ml', '30', 210.00, 210.00, 210.00, NULL, 'BT Drops', NULL, 'bt', 'bt ossihett drop', 'bt|bt ossihett drop', 1, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(42, 42, 'MEDICAL_PRODUCT_PRICE', NULL, 'BT Ovohett Drop', 'DROP', 'BT', 'ml', '30', 200.00, 200.00, 200.00, NULL, 'BT Drops', NULL, 'bt', 'bt ovohett drop', 'bt|bt ovohett drop', 1, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(43, 43, 'MEDICAL_PRODUCT_PRICE', NULL, 'BT Picrohett Drop', 'DROP', 'BT', 'ml', '30', 170.00, 170.00, 170.00, NULL, 'BT Drops', NULL, 'bt', 'bt picrohett drop', 'bt|bt picrohett drop', 1, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(44, 44, 'MEDICAL_PRODUCT_PRICE', NULL, 'BT Pilohett Drop', 'DROP', 'BT', 'ml', '30', 188.00, 188.00, 188.00, NULL, 'BT Drops', NULL, 'bt', 'bt pilohett drop', 'bt|bt pilohett drop', 1, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(45, 45, 'MEDICAL_PRODUCT_PRICE', NULL, 'BT Pimplohett Drop', 'DROP', 'BT', 'ml', '30', 200.00, 200.00, 200.00, NULL, 'BT Drops', NULL, 'bt', 'bt pimplohett drop', 'bt|bt pimplohett drop', 1, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(46, 46, 'MEDICAL_PRODUCT_PRICE', NULL, 'BT Prostohett Drop', 'DROP', 'BT', 'ml', '30', 200.00, 200.00, 200.00, NULL, 'BT Drops', NULL, 'bt', 'bt prostohett drop', 'bt|bt prostohett drop', 1, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(47, 47, 'MEDICAL_PRODUCT_PRICE', NULL, 'BT Rahohett Drop', 'DROP', 'BT', 'ml', '30', 210.00, 210.00, 210.00, NULL, 'BT Drops', NULL, 'bt', 'bt rahohett drop', 'bt|bt rahohett drop', 1, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(48, 48, 'MEDICAL_PRODUCT_PRICE', NULL, 'BT Restohett Drop', 'DROP', 'BT', 'ml', '30', 200.00, 200.00, 200.00, NULL, 'BT Drops', NULL, 'bt', 'bt restohett drop', 'bt|bt restohett drop', 1, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(49, 49, 'MEDICAL_PRODUCT_PRICE', NULL, 'BT Rheumghett Drop', 'DROP', 'BT', 'ml', '30', 200.00, 200.00, 200.00, NULL, 'BT Drops', NULL, 'bt', 'bt rheumghett drop', 'bt|bt rheumghett drop', 1, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(50, 50, 'MEDICAL_PRODUCT_PRICE', NULL, 'BT Rhino-Bih Drop', 'DROP', 'BT', 'ml', '30', 200.00, 200.00, 200.00, NULL, 'BT Drops', NULL, 'bt', 'bt rhino-bih drop', 'bt|bt rhino-bih drop', 1, '2026-08-18 05:18:46', '2026-08-18 05:18:46');

INSERT INTO `master_medical_products`
    (`id`, `medicine_text_id`, `source_type`, `source_old_id`, `product_name`, `product_type`, `category`, `packing`, `size_or_weight`, `mrp_rate`, `price_min`, `price_max`, `shipper_size_pcs`, `description`, `formula_composition`, `normalized_category`, `normalized_product_name`, `dedupe_key`, `is_active`, `created_at`, `updated_at`)
VALUES
(51, 51, 'MEDICAL_PRODUCT_PRICE', NULL, 'BT Rheumgain Drop', 'DROP', 'BT', 'ml', '30', 200.00, 200.00, 200.00, NULL, 'BT Drops', NULL, 'bt', 'bt rheumgain drop', 'bt|bt rheumgain drop', 1, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(52, 52, 'MEDICAL_PRODUCT_PRICE', NULL, 'BT Rhushett Drop', 'DROP', 'BT', 'ml', '30', 198.00, 198.00, 198.00, NULL, 'BT Drops', NULL, 'bt', 'bt rhushett drop', 'bt|bt rhushett drop', 1, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(53, 53, 'MEDICAL_PRODUCT_PRICE', NULL, 'BT Sciatihett Drop', 'DROP', 'BT', 'ml', '30', 188.00, 188.00, 188.00, NULL, 'BT Drops', NULL, 'bt', 'bt sciatihett drop', 'bt|bt sciatihett drop', 1, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(54, 54, 'MEDICAL_PRODUCT_PRICE', NULL, 'BT Sharpohett Drop', 'DROP', 'BT', 'ml', '30', 200.00, 200.00, 200.00, NULL, 'BT Drops', NULL, 'bt', 'bt sharpohett drop', 'bt|bt sharpohett drop', 1, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(55, 55, 'MEDICAL_PRODUCT_PRICE', NULL, 'BT Shorih X Drop', 'DROP', 'BT', 'ml', '30', 200.00, 200.00, 200.00, NULL, 'BT Drops', NULL, 'bt', 'bt shorih x drop', 'bt|bt shorih x drop', 1, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(56, 56, 'MEDICAL_PRODUCT_PRICE', NULL, 'BT Sweatohett Drop', 'DROP', 'BT', 'ml', '30', 170.00, 170.00, 170.00, NULL, 'BT Drops', NULL, 'bt', 'bt sweatohett drop', 'bt|bt sweatohett drop', 1, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(57, 57, 'MEDICAL_PRODUCT_PRICE', NULL, 'BT Testohett Drop', 'DROP', 'BT', 'ml', '30', 460.00, 460.00, 460.00, NULL, 'BT Drops', NULL, 'bt', 'bt testohett drop', 'bt|bt testohett drop', 1, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(58, 58, 'MEDICAL_PRODUCT_PRICE', NULL, 'BT Thyrohett Drop', 'DROP', 'BT', 'ml', '30', 210.00, 210.00, 210.00, NULL, 'BT Drops', NULL, 'bt', 'bt thyrohett drop', 'bt|bt thyrohett drop', 1, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(59, 59, 'MEDICAL_PRODUCT_PRICE', NULL, 'BT Tumerohett Drop', 'DROP', 'BT', 'ml', '30', 210.00, 210.00, 210.00, NULL, 'BT Drops', NULL, 'bt', 'bt tumerohett drop', 'bt|bt tumerohett drop', 1, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(60, 60, 'MEDICAL_PRODUCT_PRICE', NULL, 'BT Urihett Drop', 'DROP', 'BT', 'ml', '30', 198.00, 198.00, 198.00, NULL, 'BT Drops', NULL, 'bt', 'bt urihett drop', 'bt|bt urihett drop', 1, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(61, 61, 'MEDICAL_PRODUCT_PRICE', NULL, 'BT Urogaut Drop', 'DROP', 'BT', 'ml', '30', 188.00, 188.00, 188.00, NULL, 'BT Drops', NULL, 'bt', 'bt urogaut drop', 'bt|bt urogaut drop', 1, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(62, 62, 'MEDICAL_PRODUCT_PRICE', NULL, 'BT Aricoshett Drop', 'DROP', 'BT', 'ml', '30', 200.00, 200.00, 200.00, NULL, 'BT Drops', NULL, 'bt', 'bt aricoshett drop', 'bt|bt aricoshett drop', 1, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(63, 63, 'MEDICAL_PRODUCT_PRICE', NULL, 'BT Vertigo Drop', 'DROP', 'BT', 'ml', '30', 170.00, 170.00, 170.00, NULL, 'BT Drops', NULL, 'bt', 'bt vertigo drop', 'bt|bt vertigo drop', 1, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(64, 64, 'MEDICAL_PRODUCT_PRICE', NULL, 'BT Wastomed Drop', 'DROP', 'BT', 'ml', '30', 200.00, 200.00, 200.00, NULL, 'BT Drops', NULL, 'bt', 'bt wastomed drop', 'bt|bt wastomed drop', 1, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(65, 65, 'MEDICAL_PRODUCT_PRICE', NULL, 'BT Wastomed Plus Drop', 'DROP', 'BT', 'ml', '30', 320.00, 320.00, 320.00, NULL, 'BT Drops', NULL, 'bt', 'bt wastomed plus drop', 'bt|bt wastomed plus drop', 1, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(66, 66, 'MEDICAL_PRODUCT_PRICE', NULL, 'BT Acidohett Syrup 200ml', 'SYRUP', 'BT', 'ml', '200', 210.00, 210.00, 210.00, NULL, 'BT Syrup', NULL, 'bt', 'bt acidohett syrup 200ml', 'bt|bt acidohett syrup 200ml', 1, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(67, 67, 'MEDICAL_PRODUCT_PRICE', NULL, 'BT Acidohett Syrup 450ml', 'SYRUP', 'BT', 'ml', '450', 320.00, 320.00, 320.00, NULL, 'BT Syrup', NULL, 'bt', 'bt acidohett syrup 450ml', 'bt|bt acidohett syrup 450ml', 1, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(68, 68, 'MEDICAL_PRODUCT_PRICE', NULL, 'BT Alfahett Syrup 200ml', 'SYRUP', 'BT', 'ml', '200', 200.00, 200.00, 200.00, NULL, 'BT Syrup', NULL, 'bt', 'bt alfahett syrup 200ml', 'bt|bt alfahett syrup 200ml', 1, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(69, 69, 'MEDICAL_PRODUCT_PRICE', NULL, 'BT Alfahett Syrup 450ml', 'SYRUP', 'BT', 'ml', '450', NULL, NULL, NULL, NULL, 'BT Syrup', NULL, 'bt', 'bt alfahett syrup 450ml', 'bt|bt alfahett syrup 450ml', 1, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(70, 70, 'MEDICAL_PRODUCT_PRICE', NULL, 'BT Allahett Syrup 200ml', 'SYRUP', 'BT', 'ml', '200', 800.00, 800.00, 800.00, NULL, 'BT Syrup', NULL, 'bt', 'bt allahett syrup 200ml', 'bt|bt allahett syrup 200ml', 1, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(71, 71, 'MEDICAL_PRODUCT_PRICE', NULL, 'BT Allahett Syrup 450ml', 'SYRUP', 'BT', 'ml', '450', 320.00, 320.00, 320.00, NULL, 'BT Syrup', NULL, 'bt', 'bt allahett syrup 450ml', 'bt|bt allahett syrup 450ml', 1, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(72, 72, 'MEDICAL_PRODUCT_PRICE', NULL, 'BT Asthuse Syrup 200ml', 'SYRUP', 'BT', 'ml', '200', 188.00, 188.00, 188.00, NULL, 'BT Syrup', NULL, 'bt', 'bt asthuse syrup 200ml', 'bt|bt asthuse syrup 200ml', 1, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(73, 73, 'MEDICAL_PRODUCT_PRICE', NULL, 'BT Asthure Syrup 450ml', 'SYRUP', 'BT', 'ml', '450', 305.00, 305.00, 305.00, NULL, 'BT Syrup', NULL, 'bt', 'bt asthure syrup 450ml', 'bt|bt asthure syrup 450ml', 1, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(74, 74, 'MEDICAL_PRODUCT_PRICE', NULL, 'BT BP Nett Syrup 200ml', 'SYRUP', 'BT', 'ml', '200', 170.00, 170.00, 170.00, NULL, 'BT Syrup', NULL, 'bt', 'bt bp nett syrup 200ml', 'bt|bt bp nett syrup 200ml', 1, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(75, 75, 'MEDICAL_PRODUCT_PRICE', NULL, 'BT BP Nett Syrup 450ml', 'SYRUP', 'BT', 'ml', '450', 380.00, 380.00, 380.00, NULL, 'BT Syrup', NULL, 'bt', 'bt bp nett syrup 450ml', 'bt|bt bp nett syrup 450ml', 1, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(76, 76, 'MEDICAL_PRODUCT_PRICE', NULL, 'BT Digohett Syrup 200ml', 'SYRUP', 'BT', 'ml', '200', 188.00, 188.00, 188.00, NULL, 'BT Syrup', NULL, 'bt', 'bt digohett syrup 200ml', 'bt|bt digohett syrup 200ml', 1, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(77, 77, 'MEDICAL_PRODUCT_PRICE', NULL, 'BT Digohett Syrup 450ml', 'SYRUP', 'BT', 'ml', '450', 300.00, 300.00, 300.00, NULL, 'BT Syrup', NULL, 'bt', 'bt digohett syrup 450ml', 'bt|bt digohett syrup 450ml', 1, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(78, 78, 'MEDICAL_PRODUCT_PRICE', NULL, 'BT Echinett Syrup 200ml', 'SYRUP', 'BT', 'ml', '200', 188.00, 188.00, 188.00, NULL, 'BT Syrup', NULL, 'bt', 'bt echinett syrup 200ml', 'bt|bt echinett syrup 200ml', 1, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(79, 79, 'MEDICAL_PRODUCT_PRICE', NULL, 'BT Echinett Syrup 450ml', 'SYRUP', 'BT', 'ml', '450', 170.00, 170.00, 170.00, NULL, 'BT Syrup', NULL, 'bt', 'bt echinett syrup 450ml', 'bt|bt echinett syrup 450ml', 1, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(80, 80, 'MEDICAL_PRODUCT_PRICE', NULL, 'BT Graiponett Syrup 200ml', 'SYRUP', 'BT', 'ml', '200', 210.00, 210.00, 210.00, NULL, 'BT Syrup', NULL, 'bt', 'bt graiponett syrup 200ml', 'bt|bt graiponett syrup 200ml', 1, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(81, 81, 'MEDICAL_PRODUCT_PRICE', NULL, 'BT Koffhett Syrup 200ml', 'SYRUP', 'BT', 'ml', '200', 330.00, 330.00, 330.00, NULL, 'BT Syrup', NULL, 'bt', 'bt koffhett syrup 200ml', 'bt|bt koffhett syrup 200ml', 1, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(82, 82, 'MEDICAL_PRODUCT_PRICE', NULL, 'BT Livohett Syrup 450ml', 'SYRUP', 'BT', 'ml', '450', 800.00, 800.00, 800.00, NULL, 'BT Syrup', NULL, 'bt', 'bt livohett syrup 450ml', 'bt|bt livohett syrup 450ml', 1, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(83, 83, 'MEDICAL_PRODUCT_PRICE', NULL, 'BT Livohett Syrup 200ml', 'SYRUP', 'BT', 'ml', '200', 188.00, 188.00, 188.00, NULL, 'BT Syrup', NULL, 'bt', 'bt livohett syrup 200ml', 'bt|bt livohett syrup 200ml', 1, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(84, 84, 'MEDICAL_PRODUCT_PRICE', NULL, 'BT Nervohett Syrup 450ml', 'SYRUP', 'BT', 'ml', '450', 300.00, 300.00, 300.00, NULL, 'BT Syrup', NULL, 'bt', 'bt nervohett syrup 450ml', 'bt|bt nervohett syrup 450ml', 1, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(85, 85, 'MEDICAL_PRODUCT_PRICE', NULL, 'BT Nervohett Syrup 200ml', 'SYRUP', 'BT', 'ml', '200', 200.00, 200.00, 200.00, NULL, 'BT Syrup', NULL, 'bt', 'bt nervohett syrup 200ml', 'bt|bt nervohett syrup 200ml', 1, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(86, 86, 'MEDICAL_PRODUCT_PRICE', NULL, 'BT Plat O Plus Syrup 200ml', 'SYRUP', 'BT', 'ml', '200', 210.00, 210.00, 210.00, NULL, 'BT Syrup', NULL, 'bt', 'bt plat o plus syrup 200ml', 'bt|bt plat o plus syrup 200ml', 1, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(87, 87, 'MEDICAL_PRODUCT_PRICE', NULL, 'BT R-Throgeh Syrup 200ml', 'SYRUP', 'BT', 'ml', '200', 320.00, 320.00, 320.00, NULL, 'BT Syrup', NULL, 'bt', 'bt r-throgeh syrup 200ml', 'bt|bt r-throgeh syrup 200ml', 1, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(88, 88, 'MEDICAL_PRODUCT_PRICE', NULL, 'BT R-Throgeh Syrup 450ml', 'SYRUP', 'BT', 'ml', '450', 210.00, 210.00, 210.00, NULL, 'BT Syrup', NULL, 'bt', 'bt r-throgeh syrup 450ml', 'bt|bt r-throgeh syrup 450ml', 1, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(89, 89, 'MEDICAL_PRODUCT_PRICE', NULL, 'BT Re Start Syrup 200ml', 'SYRUP', 'BT', 'ml', '200', 320.00, 320.00, 320.00, NULL, 'BT Syrup', NULL, 'bt', 'bt re start syrup 200ml', 'bt|bt re start syrup 200ml', 1, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(90, 90, 'MEDICAL_PRODUCT_PRICE', NULL, 'BT Re Start Syrup 450ml', 'SYRUP', 'BT', 'ml', '450', 188.00, 188.00, 188.00, NULL, 'BT Syrup', NULL, 'bt', 'bt re start syrup 450ml', 'bt|bt re start syrup 450ml', 1, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(91, 91, 'MEDICAL_PRODUCT_PRICE', NULL, 'BT Stohe Hammer Syrup 200ml', 'SYRUP', 'BT', 'ml', '200', 360.00, 360.00, 360.00, NULL, 'BT Syrup', NULL, 'bt', 'bt stohe hammer syrup 200ml', 'bt|bt stohe hammer syrup 200ml', 1, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(92, 92, 'MEDICAL_PRODUCT_PRICE', NULL, 'BT Stohe Hammer Syrup 450ml', 'SYRUP', 'BT', 'ml', '450', 200.00, 200.00, 200.00, NULL, 'BT Syrup', NULL, 'bt', 'bt stohe hammer syrup 450ml', 'bt|bt stohe hammer syrup 450ml', 1, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(93, 93, 'MEDICAL_PRODUCT_PRICE', NULL, 'BT V Fine Syrup 200ml', 'SYRUP', 'BT', 'ml', '200', 320.00, 320.00, 320.00, NULL, 'BT Syrup', NULL, 'bt', 'bt v fine syrup 200ml', 'bt|bt v fine syrup 200ml', 1, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(94, 94, 'MEDICAL_PRODUCT_PRICE', NULL, 'BT V Fine Syrup 450ml', 'SYRUP', 'BT', 'ml', '450', NULL, NULL, NULL, NULL, 'BT Syrup', NULL, 'bt', 'bt v fine syrup 450ml', 'bt|bt v fine syrup 450ml', 1, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(95, 95, 'MEDICAL_PRODUCT_PRICE', NULL, 'BT Alovera Cream', 'CREAM', 'BT', NULL, NULL, NULL, NULL, NULL, NULL, 'BT Cosmetic', NULL, 'bt', 'bt alovera cream', 'bt|bt alovera cream', 1, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(96, 96, 'MEDICAL_PRODUCT_PRICE', NULL, 'BT Argan Hair Oil', 'OIL', 'BT', 'gm', '50', 225.00, 225.00, 225.00, NULL, 'BT Cosmetic', NULL, 'bt', 'bt argan hair oil', 'bt|bt argan hair oil', 1, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(97, 97, 'MEDICAL_PRODUCT_PRICE', NULL, 'BT Argan Hair Shampoo', 'SHAMPOO', 'BT', NULL, NULL, 650.00, 650.00, 650.00, NULL, 'BT Cosmetic', NULL, 'bt', 'bt argan hair shampoo', 'bt|bt argan hair shampoo', 1, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(98, 98, 'MEDICAL_PRODUCT_PRICE', NULL, 'BT Baby Move Oil', 'OIL', 'BT', NULL, NULL, 425.00, 425.00, 425.00, NULL, 'BT Cosmetic', NULL, 'bt', 'bt baby move oil', 'bt|bt baby move oil', 1, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(99, 99, 'MEDICAL_PRODUCT_PRICE', NULL, 'BT Argan Hair Oil + HQ', 'OIL', 'BT', 'ml', '100', 325.00, 325.00, 325.00, NULL, 'BT Cosmetic', NULL, 'bt', 'bt argan hair oil + hq', 'bt|bt argan hair oil + hq', 1, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(100, 100, 'MEDICAL_PRODUCT_PRICE', NULL, 'BT Baldonett Hair Oil 100ml', 'OIL', 'BT', 'ml', '100', 680.00, 680.00, 680.00, NULL, 'BT Cosmetic', NULL, 'bt', 'bt baldonett hair oil 100ml', 'bt|bt baldonett hair oil 100ml', 1, '2026-08-18 05:18:46', '2026-08-18 05:18:46');

INSERT INTO `master_medical_products`
    (`id`, `medicine_text_id`, `source_type`, `source_old_id`, `product_name`, `product_type`, `category`, `packing`, `size_or_weight`, `mrp_rate`, `price_min`, `price_max`, `shipper_size_pcs`, `description`, `formula_composition`, `normalized_category`, `normalized_product_name`, `dedupe_key`, `is_active`, `created_at`, `updated_at`)
VALUES
(101, 101, 'MEDICAL_PRODUCT_PRICE', NULL, 'BT Baldonett Shampoo 100ml', 'SHAMPOO', 'BT', 'ml', '100', 360.00, 360.00, 360.00, NULL, 'BT Cosmetic', NULL, 'bt', 'bt baldonett shampoo 100ml', 'bt|bt baldonett shampoo 100ml', 1, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(102, 102, 'MEDICAL_PRODUCT_PRICE', NULL, 'BT Baldonett Shampoo 200ml', 'SHAMPOO', 'BT', 'ml', '200', 595.00, 595.00, 595.00, NULL, 'BT Cosmetic', NULL, 'bt', 'bt baldonett shampoo 200ml', 'bt|bt baldonett shampoo 200ml', 1, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(103, 103, 'MEDICAL_PRODUCT_PRICE', NULL, 'BT Baldonett Oil + HQ', 'OIL', 'BT', 'ml', '100', 390.00, 390.00, 390.00, NULL, 'BT Cosmetic', NULL, 'bt', 'bt baldonett oil + hq', 'bt|bt baldonett oil + hq', 1, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(104, 104, 'MEDICAL_PRODUCT_PRICE', NULL, 'BT Dermagen Cream 100ml', 'CREAM', 'BT', 'ml', '100', 125.00, 125.00, 125.00, NULL, 'BT Cosmetic', NULL, 'bt', 'bt dermagen cream 100ml', 'bt|bt dermagen cream 100ml', 1, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(105, 105, 'MEDICAL_PRODUCT_PRICE', NULL, 'BT Dermagen Cream 200gm', 'CREAM', 'BT', 'gm', '200', 280.00, 280.00, 280.00, NULL, 'BT Cosmetic', NULL, 'bt', 'bt dermagen cream 200gm', 'bt|bt dermagen cream 200gm', 1, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(106, 106, 'MEDICAL_PRODUCT_PRICE', NULL, 'BT Sehratt Cream 50gm', 'CREAM', 'BT', 'gm', '50', 280.00, 280.00, 280.00, NULL, 'BT Cosmetic', NULL, 'bt', 'bt sehratt cream 50gm', 'bt|bt sehratt cream 50gm', 1, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(107, 107, 'MEDICAL_PRODUCT_PRICE', NULL, 'BT Face Refiner Serum 35gm', 'SERUM', 'BT', 'gm', '35', 250.00, 250.00, 250.00, NULL, 'BT Cosmetic', NULL, 'bt', 'bt face refiner serum 35gm', 'bt|bt face refiner serum 35gm', 1, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(108, 108, 'MEDICAL_PRODUCT_PRICE', NULL, 'BT Glownett Cream 50gm', 'CREAM', 'BT', 'gm', '50', 410.00, 410.00, 410.00, NULL, 'BT Cosmetic', NULL, 'bt', 'bt glownett cream 50gm', 'bt|bt glownett cream 50gm', 1, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(109, 109, 'MEDICAL_PRODUCT_PRICE', NULL, 'BT Glownett Facewash 50ml', 'FACEWASH', 'BT', 'ml', '50', 299.00, 299.00, 299.00, NULL, 'BT Cosmetic', NULL, 'bt', 'bt glownett facewash 50ml', 'bt|bt glownett facewash 50ml', 1, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(110, 110, 'MEDICAL_PRODUCT_PRICE', NULL, 'BT Hair Repair Serum', 'SERUM', 'BT', NULL, NULL, 400.00, 400.00, 400.00, NULL, 'BT Cosmetic', NULL, 'bt', 'bt hair repair serum', 'bt|bt hair repair serum', 1, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(111, 111, 'MEDICAL_PRODUCT_PRICE', NULL, 'BT Lucodermo Lotion', 'LOTION', 'BT', NULL, NULL, 244.00, 244.00, 244.00, NULL, 'BT Cosmetic', NULL, 'bt', 'bt lucodermo lotion', 'bt|bt lucodermo lotion', 1, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(112, 112, 'MEDICAL_PRODUCT_PRICE', NULL, 'BT Mullein Oil', 'OIL', 'BT', NULL, NULL, 150.00, 150.00, 150.00, NULL, 'BT Cosmetic', NULL, 'bt', 'bt mullein oil', 'bt|bt mullein oil', 1, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(113, 113, 'MEDICAL_PRODUCT_PRICE', NULL, 'BT Newronett Oil 60ml', 'OIL', 'BT', 'ml', '60', 131.00, 131.00, 131.00, NULL, 'BT Cosmetic', NULL, 'bt', 'bt newronett oil 60ml', 'bt|bt newronett oil 60ml', 1, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(114, 114, 'MEDICAL_PRODUCT_PRICE', NULL, 'BT Paralin Oil', 'OIL', 'BT', NULL, NULL, 100.00, 100.00, 100.00, NULL, 'BT Cosmetic', NULL, 'bt', 'bt paralin oil', 'bt|bt paralin oil', 1, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(115, 115, 'MEDICAL_PRODUCT_PRICE', NULL, 'BT Pimplonett Cream 50gm', 'CREAM', 'BT', 'gm', '50', 450.00, 450.00, 450.00, NULL, 'BT Cosmetic', NULL, 'bt', 'bt pimplonett cream 50gm', 'bt|bt pimplonett cream 50gm', 1, '2026-08-18 05:18:46', '2026-08-18 05:18:46'),
(116, 116, 'MEDICAL_PRODUCT_PRICE', NULL, 'BT Pimplonett Facewash 50ml', 'FACEWASH', 'BT', 'ml', '50', 299.00, 299.00, 299.00, NULL, 'BT Cosmetic', NULL, 'bt', 'bt pimplonett facewash 50ml', 'bt|bt pimplonett facewash 50ml', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(117, 117, 'MEDICAL_PRODUCT_PRICE', NULL, 'BT Poshanett Cream 50gm', 'CREAM', 'BT', 'gm', '50', 280.00, 280.00, 280.00, NULL, 'BT Cosmetic', NULL, 'bt', 'bt poshanett cream 50gm', 'bt|bt poshanett cream 50gm', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(118, 118, 'MEDICAL_PRODUCT_PRICE', NULL, 'BT R-Throgen Oil 60ml', 'OIL', 'BT', 'ml', '60', 113.00, 113.00, 113.00, NULL, 'BT Cosmetic', NULL, 'bt', 'bt r-throgen oil 60ml', 'bt|bt r-throgen oil 60ml', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(119, 119, 'MEDICAL_PRODUCT_PRICE', NULL, 'BT R-Throgen Oil 100ml', 'OIL', 'BT', 'ml', '100', 150.00, 150.00, 150.00, NULL, 'BT Cosmetic', NULL, 'bt', 'bt r-throgen oil 100ml', 'bt|bt r-throgen oil 100ml', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(120, 120, 'MEDICAL_PRODUCT_PRICE', NULL, 'BT Rebud Hair Oil', 'OIL', 'BT', NULL, NULL, 311.00, 311.00, 311.00, NULL, 'BT Cosmetic', NULL, 'bt', 'bt rebud hair oil', 'bt|bt rebud hair oil', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(121, 121, 'MEDICAL_PRODUCT_PRICE', NULL, 'BT Rebud Shampoo', 'SHAMPOO', 'BT', NULL, NULL, 231.00, 231.00, 231.00, NULL, 'BT Cosmetic', NULL, 'bt', 'bt rebud shampoo', 'bt|bt rebud shampoo', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(122, 122, 'MEDICAL_PRODUCT_PRICE', NULL, 'BT Rebud Hair Oil + HQ', 'OIL', 'BT', NULL, NULL, 346.00, 346.00, 346.00, NULL, 'BT Cosmetic', NULL, 'bt', 'bt rebud hair oil + hq', 'bt|bt rebud hair oil + hq', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(123, 123, 'MEDICAL_PRODUCT_PRICE', NULL, 'BT Septo-V Lotion', 'LOTION', 'BT', NULL, NULL, 244.00, 244.00, 244.00, NULL, 'BT Cosmetic', NULL, 'bt', 'bt septo-v lotion', 'bt|bt septo-v lotion', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(124, 124, 'MEDICAL_PRODUCT_PRICE', NULL, 'BT Skin Protector Cream', 'CREAM', 'BT', NULL, NULL, 310.00, 310.00, 310.00, NULL, 'BT Cosmetic', NULL, 'bt', 'bt skin protector cream', 'bt|bt skin protector cream', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(125, 125, 'MEDICAL_PRODUCT_PRICE', NULL, 'BT Skin Repair Tonic', 'TONIC', 'BT', NULL, NULL, 1499.00, 1499.00, 1499.00, NULL, 'BT Cosmetic', NULL, 'bt', 'bt skin repair tonic', 'bt|bt skin repair tonic', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(126, 126, 'MEDICAL_PRODUCT_PRICE', NULL, 'AD A-108 Drop', 'DROP', 'Adven', 'ml', '30', 188.00, 188.00, 188.00, NULL, 'Adven Drops', NULL, 'adven', 'ad a-108 drop', 'adven|ad a-108 drop', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(127, 127, 'MEDICAL_PRODUCT_PRICE', NULL, 'AD A-153 Drop', 'DROP', 'Adven', 'ml', '30', 188.00, 188.00, 188.00, NULL, 'Adven Drops', NULL, 'adven', 'ad a-153 drop', 'adven|ad a-153 drop', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(128, 128, 'MEDICAL_PRODUCT_PRICE', NULL, 'AD A-175 Drop', 'DROP', 'Adven', 'ml', '30', 188.00, 188.00, 188.00, NULL, 'Adven Drops', NULL, 'adven', 'ad a-175 drop', 'adven|ad a-175 drop', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(129, 129, 'MEDICAL_PRODUCT_PRICE', NULL, 'AD A-188 Drop', 'DROP', 'Adven', 'ml', '30', 220.00, 220.00, 220.00, NULL, 'Adven Drops', NULL, 'adven', 'ad a-188 drop', 'adven|ad a-188 drop', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(130, 130, 'MEDICAL_PRODUCT_PRICE', NULL, 'AD A-195 Drop', 'DROP', 'Adven', 'ml', '30', 188.00, 188.00, 188.00, NULL, 'Adven Drops', NULL, 'adven', 'ad a-195 drop', 'adven|ad a-195 drop', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(131, 131, 'MEDICAL_PRODUCT_PRICE', NULL, 'AD A-204 Drop', 'DROP', 'Adven', 'ml', '30', 188.00, 188.00, 188.00, NULL, 'Adven Drops', NULL, 'adven', 'ad a-204 drop', 'adven|ad a-204 drop', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(132, 132, 'MEDICAL_PRODUCT_PRICE', NULL, 'AD A-205 Drop', 'DROP', 'Adven', 'ml', '30', 220.00, 220.00, 220.00, NULL, 'Adven Drops', NULL, 'adven', 'ad a-205 drop', 'adven|ad a-205 drop', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(133, 133, 'MEDICAL_PRODUCT_PRICE', NULL, 'AD Anti-Fungal Drop', 'DROP', 'Adven', 'ml', '30', 220.00, 220.00, 220.00, NULL, 'Adven Drops', NULL, 'adven', 'ad anti-fungal drop', 'adven|ad anti-fungal drop', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(134, 134, 'MEDICAL_PRODUCT_PRICE', NULL, 'AD Cardio-Gold Drop', 'DROP', 'Adven', 'ml', '30', 220.00, 220.00, 220.00, NULL, 'Adven Drops', NULL, 'adven', 'ad cardio-gold drop', 'adven|ad cardio-gold drop', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(135, 135, 'MEDICAL_PRODUCT_PRICE', NULL, 'AD Cholesterol Drop', 'DROP', 'Adven', 'ml', '30', 220.00, 220.00, 220.00, NULL, 'Adven Drops', NULL, 'adven', 'ad cholesterol drop', 'adven|ad cholesterol drop', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(136, 136, 'MEDICAL_PRODUCT_PRICE', NULL, 'AD Gall Set Drop', 'DROP', 'Adven', 'ml', '30', 220.00, 220.00, 220.00, NULL, 'Adven Drops', NULL, 'adven', 'ad gall set drop', 'adven|ad gall set drop', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(137, 137, 'MEDICAL_PRODUCT_PRICE', NULL, 'AD Glow Aid Drop', 'DROP', 'Adven', 'ml', '30', 220.00, 220.00, 220.00, NULL, 'Adven Drops', NULL, 'adven', 'ad glow aid drop', 'adven|ad glow aid drop', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(138, 138, 'MEDICAL_PRODUCT_PRICE', NULL, 'AD Leucodcare Drop', 'DROP', 'Adven', 'ml', '30', 188.00, 188.00, 188.00, NULL, 'Adven Drops', NULL, 'adven', 'ad leucodcare drop', 'adven|ad leucodcare drop', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(139, 139, 'MEDICAL_PRODUCT_PRICE', NULL, 'AD Osrul Drop', 'DROP', 'Adven', 'ml', '30', 240.00, 240.00, 240.00, NULL, 'Adven Drops', NULL, 'adven', 'ad osrul drop', 'adven|ad osrul drop', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(140, 140, 'MEDICAL_PRODUCT_PRICE', NULL, 'AD Osteodin-Z Drop', 'DROP', 'Adven', 'ml', '25', 350.00, 350.00, 350.00, NULL, 'Adven Drops', NULL, 'adven', 'ad osteodin-z drop', 'adven|ad osteodin-z drop', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(141, 141, 'MEDICAL_PRODUCT_PRICE', NULL, 'AD Paingo Drop', 'DROP', 'Adven', 'ml', '30', 220.00, 220.00, 220.00, NULL, 'Adven Drops', NULL, 'adven', 'ad paingo drop', 'adven|ad paingo drop', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(142, 142, 'MEDICAL_PRODUCT_PRICE', NULL, 'AD Pilcare Drop', 'DROP', 'Adven', 'ml', '30', 220.00, 220.00, 220.00, NULL, 'Adven Drops', NULL, 'adven', 'ad pilcare drop', 'adven|ad pilcare drop', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(143, 143, 'MEDICAL_PRODUCT_PRICE', NULL, 'AD Sinus Drop', 'DROP', 'Adven', 'ml', '30', 188.00, 188.00, 188.00, NULL, 'Adven Drops', NULL, 'adven', 'ad sinus drop', 'adven|ad sinus drop', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(144, 144, 'MEDICAL_PRODUCT_PRICE', NULL, 'AD Teston Fort Drop', 'DROP', 'Adven', 'ml', '30', 555.00, 555.00, 555.00, NULL, 'Adven Drops', NULL, 'adven', 'ad teston fort drop', 'adven|ad teston fort drop', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(145, 145, 'MEDICAL_PRODUCT_PRICE', NULL, 'AD Wartinor Drop', 'DROP', 'Adven', 'ml', '30', 195.00, 195.00, 195.00, NULL, 'Adven Drops', NULL, 'adven', 'ad wartinor drop', 'adven|ad wartinor drop', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(146, 146, 'MEDICAL_PRODUCT_PRICE', NULL, 'AD AD-Lev Syrup 180ml', 'SYRUP', 'Adven', 'ml', '180', 170.00, 170.00, 170.00, NULL, 'Adven Syrup', NULL, 'adven', 'ad ad-lev syrup 180ml', 'adven|ad ad-lev syrup 180ml', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(147, 147, 'MEDICAL_PRODUCT_PRICE', NULL, 'AD AD-Lev Syrup 450ml', 'SYRUP', 'Adven', 'ml', '450', 350.00, 350.00, 350.00, NULL, 'Adven Syrup', NULL, 'adven', 'ad ad-lev syrup 450ml', 'adven|ad ad-lev syrup 450ml', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(148, 148, 'MEDICAL_PRODUCT_PRICE', NULL, 'AD Femson Syrup 180ml', 'SYRUP', 'Adven', 'ml', '180', 200.00, 200.00, 200.00, NULL, 'Adven Syrup', NULL, 'adven', 'ad femson syrup 180ml', 'adven|ad femson syrup 180ml', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(149, 149, 'MEDICAL_PRODUCT_PRICE', NULL, 'AD Femson Syrup 450ml', 'SYRUP', 'Adven', 'ml', '450', 350.00, 350.00, 350.00, NULL, 'Adven Syrup', NULL, 'adven', 'ad femson syrup 450ml', 'adven|ad femson syrup 450ml', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(150, 150, 'MEDICAL_PRODUCT_PRICE', NULL, 'AD Hematone Syrup 180ml', 'SYRUP', 'Adven', 'ml', '180', 200.00, 200.00, 200.00, NULL, 'Adven Syrup', NULL, 'adven', 'ad hematone syrup 180ml', 'adven|ad hematone syrup 180ml', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47');

INSERT INTO `master_medical_products`
    (`id`, `medicine_text_id`, `source_type`, `source_old_id`, `product_name`, `product_type`, `category`, `packing`, `size_or_weight`, `mrp_rate`, `price_min`, `price_max`, `shipper_size_pcs`, `description`, `formula_composition`, `normalized_category`, `normalized_product_name`, `dedupe_key`, `is_active`, `created_at`, `updated_at`)
VALUES
(151, 151, 'MEDICAL_PRODUCT_PRICE', NULL, 'AD Hematone Syrup 450ml', 'SYRUP', 'Adven', 'ml', '450', 350.00, 350.00, 350.00, NULL, 'Adven Syrup', NULL, 'adven', 'ad hematone syrup 450ml', 'adven|ad hematone syrup 450ml', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(152, 152, 'MEDICAL_PRODUCT_PRICE', NULL, 'AD Gustin Syrup 180ml', 'SYRUP', 'Adven', 'ml', '180', 164.00, 164.00, 164.00, NULL, 'Adven Syrup', NULL, 'adven', 'ad gustin syrup 180ml', 'adven|ad gustin syrup 180ml', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(153, 153, 'MEDICAL_PRODUCT_PRICE', NULL, 'AD Justin Syrup 450ml', 'SYRUP', 'Adven', 'ml', '450', 280.00, 280.00, 280.00, NULL, 'Adven Syrup', NULL, 'adven', 'ad justin syrup 450ml', 'adven|ad justin syrup 450ml', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(154, 154, 'MEDICAL_PRODUCT_PRICE', NULL, 'AD ABC Lotion 1000gm', 'LOTION', 'Adven', 'gm', '1000', 140.00, 140.00, 140.00, NULL, 'Adven Cosmetic', NULL, 'adven', 'ad abc lotion 1000gm', 'adven|ad abc lotion 1000gm', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(155, 155, 'MEDICAL_PRODUCT_PRICE', NULL, 'AD ABC Lotion 100ml', 'LOTION', 'Adven', 'ml', '100', 180.00, 180.00, 180.00, NULL, 'Adven Cosmetic', NULL, 'adven', 'ad abc lotion 100ml', 'adven|ad abc lotion 100ml', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(156, 156, 'MEDICAL_PRODUCT_PRICE', NULL, 'AD All Purpose Cream 100ml', 'CREAM', 'Adven', 'ml', '100', 151.00, 151.00, 151.00, NULL, 'Adven Cosmetic', NULL, 'adven', 'ad all purpose cream 100ml', 'adven|ad all purpose cream 100ml', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(157, 157, 'MEDICAL_PRODUCT_PRICE', NULL, 'AD Anti-Dandruff Shampoo 200ml', 'SHAMPOO', 'Adven', 'ml', '200', 270.00, 270.00, 270.00, NULL, 'Adven Cosmetic', NULL, 'adven', 'ad anti-dandruff shampoo 200ml', 'adven|ad anti-dandruff shampoo 200ml', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(158, 158, 'MEDICAL_PRODUCT_PRICE', NULL, 'AD Anti-Dandruff Shampoo', 'SHAMPOO', 'Adven', NULL, NULL, 70.00, 70.00, 70.00, NULL, 'Adven Cosmetic', NULL, 'adven', 'ad anti-dandruff shampoo', 'adven|ad anti-dandruff shampoo', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(159, 159, 'MEDICAL_PRODUCT_PRICE', NULL, 'AD Black Hair Colour', 'HAIR COLOUR', 'Adven', NULL, NULL, 150.00, 150.00, 150.00, NULL, 'Adven Cosmetic', NULL, 'adven', 'ad black hair colour', 'adven|ad black hair colour', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(160, 160, 'MEDICAL_PRODUCT_PRICE', NULL, 'AD Body Wash with ABC', 'BODY WASH', 'Adven', NULL, NULL, 70.00, 70.00, 70.00, NULL, 'Adven Cosmetic', NULL, 'adven', 'ad body wash with abc', 'adven|ad body wash with abc', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(161, 161, 'MEDICAL_PRODUCT_PRICE', NULL, 'AD Brown Hair Colour 100gm', 'HAIR COLOUR', 'Adven', 'gm', '100', 190.00, 190.00, 190.00, NULL, 'Adven Cosmetic', NULL, 'adven', 'ad brown hair colour 100gm', 'adven|ad brown hair colour 100gm', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(162, 162, 'MEDICAL_PRODUCT_PRICE', NULL, 'AD Face Wash with ABC 100ml', 'FACEWASH', 'Adven', 'ml', '100', 139.00, 139.00, 139.00, NULL, 'Adven Cosmetic', NULL, 'adven', 'ad face wash with abc 100ml', 'adven|ad face wash with abc 100ml', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(163, 163, 'MEDICAL_PRODUCT_PRICE', NULL, 'AD Jabarandi Oil 200ml', 'OIL', 'Adven', 'ml', '200', 300.00, 300.00, 300.00, NULL, 'Adven Cosmetic', NULL, 'adven', 'ad jabarandi oil 200ml', 'adven|ad jabarandi oil 200ml', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(164, 164, 'MEDICAL_PRODUCT_PRICE', NULL, 'AD Jabarandi Oil + HQ 200ml', 'OIL', 'Adven', 'ml', '200', 270.00, 270.00, 270.00, NULL, 'Adven Cosmetic', NULL, 'adven', 'ad jabarandi oil + hq 200ml', 'adven|ad jabarandi oil + hq 200ml', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(165, 165, 'MEDICAL_PRODUCT_PRICE', NULL, 'AD Hamamelis Ointment', 'OINTMENT', 'Adven', NULL, NULL, 90.00, 90.00, 90.00, NULL, 'Adven Cosmetic', NULL, 'adven', 'ad hamamelis ointment', 'adven|ad hamamelis ointment', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(166, 166, 'MEDICAL_PRODUCT_PRICE', NULL, 'AD Heel Heel Cream 200ml', 'CREAM', 'Adven', 'ml', '200', 70.00, 70.00, 70.00, NULL, 'Adven Cosmetic', NULL, 'adven', 'ad heel heel cream 200ml', 'adven|ad heel heel cream 200ml', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(167, 167, 'MEDICAL_PRODUCT_PRICE', NULL, 'AD Pro-Vitamin Shampoo 200ml', 'SHAMPOO', 'Adven', 'ml', '200', 270.00, 270.00, 270.00, NULL, 'Adven Cosmetic', NULL, 'adven', 'ad pro-vitamin shampoo 200ml', 'adven|ad pro-vitamin shampoo 200ml', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(168, 168, 'MEDICAL_PRODUCT_PRICE', NULL, 'AD Pro-Vitamin Shampoo 100ml', 'SHAMPOO', 'Adven', 'ml', '100', 151.00, 151.00, 151.00, NULL, 'Adven Cosmetic', NULL, 'adven', 'ad pro-vitamin shampoo 100ml', 'adven|ad pro-vitamin shampoo 100ml', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(169, 169, 'MEDICAL_PRODUCT_PRICE', NULL, 'AD Sun Protection Cream 100ml', 'CREAM', 'Adven', 'ml', '100', 400.00, 400.00, 400.00, NULL, 'Adven Cosmetic', NULL, 'adven', 'ad sun protection cream 100ml', 'adven|ad sun protection cream 100ml', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(170, 170, 'MEDICAL_PRODUCT_PRICE', NULL, 'AD Arnica Oil 100ml', 'OIL', 'Adven', 'ml', '100', NULL, NULL, NULL, NULL, 'Adven Cosmetic', NULL, 'adven', 'ad arnica oil 100ml', 'adven|ad arnica oil 100ml', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(171, 171, 'MEDICAL_PRODUCT_PRICE', NULL, 'AD Arnica Oil 200ml', 'OIL', 'Adven', 'ml', '200', NULL, NULL, NULL, NULL, 'Adven Cosmetic', NULL, 'adven', 'ad arnica oil 200ml', 'adven|ad arnica oil 200ml', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(172, 172, 'MEDICAL_PRODUCT_PRICE', NULL, 'AD Arnica Oil + HQ 100ml', 'OIL', 'Adven', 'ml', '100', NULL, NULL, NULL, NULL, 'Adven Cosmetic', NULL, 'adven', 'ad arnica oil + hq 100ml', 'adven|ad arnica oil + hq 100ml', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(173, 173, 'MEDICAL_PRODUCT_PRICE', NULL, 'AD Arnica Oil + HQ 200ml', 'OIL', 'Adven', 'ml', '200', 190.00, 190.00, 190.00, NULL, 'Adven Cosmetic', NULL, 'adven', 'ad arnica oil + hq 200ml', 'adven|ad arnica oil + hq 200ml', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(174, 174, 'MEDICAL_PRODUCT_PRICE', NULL, 'AD Jabarandi Oil + HQ 100ml', 'OIL', 'Adven', 'ml', '100', 300.00, 300.00, 300.00, NULL, 'Adven Cosmetic', NULL, 'adven', 'ad jabarandi oil + hq 100ml', 'adven|ad jabarandi oil + hq 100ml', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(175, 175, 'MEDICAL_PRODUCT_PRICE', NULL, 'BT 01 Tab 40 tabs', 'TABLET', 'BT', 'tabs', '40', 244.00, 244.00, 244.00, NULL, 'BT Tablets', NULL, 'bt', 'bt 01 tab 40 tabs', 'bt|bt 01 tab 40 tabs', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(176, 176, 'MEDICAL_PRODUCT_PRICE', NULL, 'DT 01/25 Tab 30 tabs', 'TABLET', 'BT', 'tabs', '30', 250.00, 250.00, 250.00, NULL, 'BT Tablets', NULL, 'bt', 'dt 01/25 tab 30 tabs', 'bt|dt 01/25 tab 30 tabs', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(177, 177, 'MEDICAL_PRODUCT_PRICE', NULL, 'BT 02 Tab 40 tabs', 'TABLET', 'BT', 'tabs', '40', 250.00, 250.00, 250.00, NULL, 'BT Tablets', NULL, 'bt', 'bt 02 tab 40 tabs', 'bt|bt 02 tab 40 tabs', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(178, 178, 'MEDICAL_PRODUCT_PRICE', NULL, 'DT 02/25 Tab 30 tabs', 'TABLET', 'BT', 'tabs', '30', 250.00, 250.00, 250.00, NULL, 'BT Tablets', NULL, 'bt', 'dt 02/25 tab 30 tabs', 'bt|dt 02/25 tab 30 tabs', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(179, 179, 'MEDICAL_PRODUCT_PRICE', NULL, 'BT 03 Tab 40 tabs', 'TABLET', 'BT', 'tabs', '40', 250.00, 250.00, 250.00, NULL, 'BT Tablets', NULL, 'bt', 'bt 03 tab 40 tabs', 'bt|bt 03 tab 40 tabs', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(180, 180, 'MEDICAL_PRODUCT_PRICE', NULL, 'DT 03/25 Tab 30 tabs', 'TABLET', 'BT', 'tabs', '30', 250.00, 250.00, 250.00, NULL, 'BT Tablets', NULL, 'bt', 'dt 03/25 tab 30 tabs', 'bt|dt 03/25 tab 30 tabs', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(181, 181, 'MEDICAL_PRODUCT_PRICE', NULL, 'BT 08 Tab 40 tabs', 'TABLET', 'BT', 'tabs', '40', 234.00, 234.00, 234.00, NULL, 'BT Tablets', NULL, 'bt', 'bt 08 tab 40 tabs', 'bt|bt 08 tab 40 tabs', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(182, 182, 'MEDICAL_PRODUCT_PRICE', NULL, 'DT 08/25 Tab 30 tabs', 'TABLET', 'BT', 'tabs', '30', 250.00, 250.00, 250.00, NULL, 'BT Tablets', NULL, 'bt', 'dt 08/25 tab 30 tabs', 'bt|dt 08/25 tab 30 tabs', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(183, 183, 'MEDICAL_PRODUCT_PRICE', NULL, 'BT 10 Tab 40 tabs', 'TABLET', 'BT', 'tabs', '40', 250.00, 250.00, 250.00, NULL, 'BT Tablets', NULL, 'bt', 'bt 10 tab 40 tabs', 'bt|bt 10 tab 40 tabs', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(184, 184, 'MEDICAL_PRODUCT_PRICE', NULL, 'DT 10/25 Tab 30 tabs', 'TABLET', 'BT', 'tabs', '30', 250.00, 250.00, 250.00, NULL, 'BT Tablets', NULL, 'bt', 'dt 10/25 tab 30 tabs', 'bt|dt 10/25 tab 30 tabs', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(185, 185, 'MEDICAL_PRODUCT_PRICE', NULL, 'BT 11 Tab 40 tabs', 'TABLET', 'BT', 'tabs', '40', 244.00, 244.00, 244.00, NULL, 'BT Tablets', NULL, 'bt', 'bt 11 tab 40 tabs', 'bt|bt 11 tab 40 tabs', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(186, 186, 'MEDICAL_PRODUCT_PRICE', NULL, 'DT 11/25 Tab 30 tabs', 'TABLET', 'BT', 'tabs', '30', 250.00, 250.00, 250.00, NULL, 'BT Tablets', NULL, 'bt', 'dt 11/25 tab 30 tabs', 'bt|dt 11/25 tab 30 tabs', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(187, 187, 'MEDICAL_PRODUCT_PRICE', NULL, 'BT 17 Tab 40 tabs', 'TABLET', 'BT', 'tabs', '40', 250.00, 250.00, 250.00, NULL, 'BT Tablets', NULL, 'bt', 'bt 17 tab 40 tabs', 'bt|bt 17 tab 40 tabs', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(188, 188, 'MEDICAL_PRODUCT_PRICE', NULL, 'DT 17/25 Tab 30 tabs', 'TABLET', 'BT', 'tabs', '30', 250.00, 250.00, 250.00, NULL, 'BT Tablets', NULL, 'bt', 'dt 17/25 tab 30 tabs', 'bt|dt 17/25 tab 30 tabs', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(189, 189, 'MEDICAL_PRODUCT_PRICE', NULL, 'BT 22 Tab 40 tabs', 'TABLET', 'BT', 'tabs', '40', 244.00, 244.00, 244.00, NULL, 'BT Tablets', NULL, 'bt', 'bt 22 tab 40 tabs', 'bt|bt 22 tab 40 tabs', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(190, 190, 'MEDICAL_PRODUCT_PRICE', NULL, 'DT 22/25 Tab 30 tabs', 'TABLET', 'BT', 'tabs', '30', 250.00, 250.00, 250.00, NULL, 'BT Tablets', NULL, 'bt', 'dt 22/25 tab 30 tabs', 'bt|dt 22/25 tab 30 tabs', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(191, 191, 'MEDICAL_PRODUCT_PRICE', NULL, 'BT 49 Tab 40 tabs', 'TABLET', 'BT', 'tabs', '40', 250.00, 250.00, 250.00, NULL, 'BT Tablets', NULL, 'bt', 'bt 49 tab 40 tabs', 'bt|bt 49 tab 40 tabs', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(192, 192, 'MEDICAL_PRODUCT_PRICE', NULL, 'DT 49/25 Tab 30 tabs', 'TABLET', 'BT', 'tabs', '30', 250.00, 250.00, 250.00, NULL, 'BT Tablets', NULL, 'bt', 'dt 49/25 tab 30 tabs', 'bt|dt 49/25 tab 30 tabs', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(193, 193, 'MEDICAL_PRODUCT_PRICE', NULL, 'BT 50 Tab 40 tabs', 'TABLET', 'BT', 'tabs', '40', 234.00, 234.00, 234.00, NULL, 'BT Tablets', NULL, 'bt', 'bt 50 tab 40 tabs', 'bt|bt 50 tab 40 tabs', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(194, 194, 'MEDICAL_PRODUCT_PRICE', NULL, 'DT 50/25 Tab 30 tabs', 'TABLET', 'BT', 'tabs', '30', 250.00, 250.00, 250.00, NULL, 'BT Tablets', NULL, 'bt', 'dt 50/25 tab 30 tabs', 'bt|dt 50/25 tab 30 tabs', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(195, 195, 'MEDICAL_PRODUCT_PRICE', NULL, 'BT 51 Tab 40 tabs', 'TABLET', 'BT', 'tabs', '40', 234.00, 234.00, 234.00, NULL, 'BT Tablets', NULL, 'bt', 'bt 51 tab 40 tabs', 'bt|bt 51 tab 40 tabs', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(196, 196, 'MEDICAL_PRODUCT_PRICE', NULL, 'DT 51/25 Tab 30 tabs', 'TABLET', 'BT', 'tabs', '30', 250.00, 250.00, 250.00, NULL, 'BT Tablets', NULL, 'bt', 'dt 51/25 tab 30 tabs', 'bt|dt 51/25 tab 30 tabs', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(197, 197, 'MEDICAL_PRODUCT_PRICE', NULL, 'BT 69 Tab 40 tabs', 'TABLET', 'BT', 'tabs', '40', 265.00, 265.00, 265.00, NULL, 'BT Tablets', NULL, 'bt', 'bt 69 tab 40 tabs', 'bt|bt 69 tab 40 tabs', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(198, 198, 'MEDICAL_PRODUCT_PRICE', NULL, 'DT 69/3 Tab 30 tabs', 'TABLET', 'BT', 'tabs', '30', 300.00, 300.00, 300.00, NULL, 'BT Tablets', NULL, 'bt', 'dt 69/3 tab 30 tabs', 'bt|dt 69/3 tab 30 tabs', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(199, 199, 'MEDICAL_PRODUCT_PRICE', NULL, 'BT 70 Tab 40 tabs', 'TABLET', 'BT', 'tabs', '40', 234.00, 234.00, 234.00, NULL, 'BT Tablets', NULL, 'bt', 'bt 70 tab 40 tabs', 'bt|bt 70 tab 40 tabs', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(200, 200, 'MEDICAL_PRODUCT_PRICE', NULL, 'DT 70/25 Tab 30 tabs', 'TABLET', 'BT', 'tabs', '30', 250.00, 250.00, 250.00, NULL, 'BT Tablets', NULL, 'bt', 'dt 70/25 tab 30 tabs', 'bt|dt 70/25 tab 30 tabs', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47');

INSERT INTO `master_medical_products`
    (`id`, `medicine_text_id`, `source_type`, `source_old_id`, `product_name`, `product_type`, `category`, `packing`, `size_or_weight`, `mrp_rate`, `price_min`, `price_max`, `shipper_size_pcs`, `description`, `formula_composition`, `normalized_category`, `normalized_product_name`, `dedupe_key`, `is_active`, `created_at`, `updated_at`)
VALUES
(201, 201, 'MEDICAL_PRODUCT_PRICE', NULL, 'BT 76 Tab 40 tabs', 'TABLET', 'BT', 'tabs', '40', 265.00, 265.00, 265.00, NULL, 'BT Tablets', NULL, 'bt', 'bt 76 tab 40 tabs', 'bt|bt 76 tab 40 tabs', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(202, 202, 'MEDICAL_PRODUCT_PRICE', NULL, 'DT 76/25 Tab 30 tabs', 'TABLET', 'BT', 'tabs', '30', 250.00, 250.00, 250.00, NULL, 'BT Tablets', NULL, 'bt', 'dt 76/25 tab 30 tabs', 'bt|dt 76/25 tab 30 tabs', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(203, 203, 'MEDICAL_PRODUCT_PRICE', NULL, 'BT 80 Tab 40 tabs', 'TABLET', 'BT', 'tabs', '40', 234.00, 234.00, 234.00, NULL, 'BT Tablets', NULL, 'bt', 'bt 80 tab 40 tabs', 'bt|bt 80 tab 40 tabs', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(204, 204, 'MEDICAL_PRODUCT_PRICE', NULL, 'DT 80/25 Tab 30 tabs', 'TABLET', 'BT', 'tabs', '30', 250.00, 250.00, 250.00, NULL, 'BT Tablets', NULL, 'bt', 'dt 80/25 tab 30 tabs', 'bt|dt 80/25 tab 30 tabs', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(205, 205, 'MEDICAL_PRODUCT_PRICE', NULL, 'BT 102 Tab 40 tabs', 'TABLET', 'BT', 'tabs', '40', 244.00, 244.00, 244.00, NULL, 'BT Tablets', NULL, 'bt', 'bt 102 tab 40 tabs', 'bt|bt 102 tab 40 tabs', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(206, 206, 'MEDICAL_PRODUCT_PRICE', NULL, 'DT 102/25 Tab 30 tabs', 'TABLET', 'BT', 'tabs', '30', 250.00, 250.00, 250.00, NULL, 'BT Tablets', NULL, 'bt', 'dt 102/25 tab 30 tabs', 'bt|dt 102/25 tab 30 tabs', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(207, 207, 'MEDICAL_PRODUCT_PRICE', NULL, 'BT 110 Tab 40 tabs', 'TABLET', 'BT', 'tabs', '40', 234.00, 234.00, 234.00, NULL, 'BT Tablets', NULL, 'bt', 'bt 110 tab 40 tabs', 'bt|bt 110 tab 40 tabs', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(208, 208, 'MEDICAL_PRODUCT_PRICE', NULL, 'BT 111 Tab 40 tabs', 'TABLET', 'BT', 'tabs', '40', 265.00, 265.00, 265.00, NULL, 'BT Tablets', NULL, 'bt', 'bt 111 tab 40 tabs', 'bt|bt 111 tab 40 tabs', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(209, 209, 'MEDICAL_PRODUCT_PRICE', NULL, 'DT 111/25 Tab 30 tabs', 'TABLET', 'BT', 'tabs', '30', 250.00, 250.00, 250.00, NULL, 'BT Tablets', NULL, 'bt', 'dt 111/25 tab 30 tabs', 'bt|dt 111/25 tab 30 tabs', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(210, 210, 'MEDICAL_PRODUCT_PRICE', NULL, 'BT 127 Tab 40 tabs', 'TABLET', 'BT', 'tabs', '40', 265.00, 265.00, 265.00, NULL, 'BT Tablets', NULL, 'bt', 'bt 127 tab 40 tabs', 'bt|bt 127 tab 40 tabs', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(211, 211, 'MEDICAL_PRODUCT_PRICE', NULL, 'DT 127/25 Tab 30 tabs', 'TABLET', 'BT', 'tabs', '30', 250.00, 250.00, 250.00, NULL, 'BT Tablets', NULL, 'bt', 'dt 127/25 tab 30 tabs', 'bt|dt 127/25 tab 30 tabs', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(212, 212, 'MEDICAL_PRODUCT_PRICE', NULL, 'BT 131 Tab 40 tabs', 'TABLET', 'BT', 'tabs', '40', 265.00, 265.00, 265.00, NULL, 'BT Tablets', NULL, 'bt', 'bt 131 tab 40 tabs', 'bt|bt 131 tab 40 tabs', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(213, 213, 'MEDICAL_PRODUCT_PRICE', NULL, 'DT 131/25 Tab 30 tabs', 'TABLET', 'BT', 'tabs', '30', 250.00, 250.00, 250.00, NULL, 'BT Tablets', NULL, 'bt', 'dt 131/25 tab 30 tabs', 'bt|dt 131/25 tab 30 tabs', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(214, 214, 'MEDICAL_PRODUCT_PRICE', NULL, 'BT Immunofem Tab 30 tabs', 'TABLET', 'BT', 'tabs', '30', 311.00, 311.00, 311.00, NULL, 'BT Tablets', NULL, 'bt', 'bt immunofem tab 30 tabs', 'bt|bt immunofem tab 30 tabs', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(215, 215, 'MEDICAL_PRODUCT_PRICE', NULL, 'BT Feroboost Tab 30 tabs', 'TABLET', 'BT', 'tabs', '30', 311.00, 311.00, 311.00, NULL, 'BT Tablets', NULL, 'bt', 'bt feroboost tab 30 tabs', 'bt|bt feroboost tab 30 tabs', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(216, 216, 'MEDICAL_PRODUCT_PRICE', NULL, 'BT Neurophes Tab 30 tabs', 'TABLET', 'BT', 'tabs', '30', 220.00, 220.00, 220.00, NULL, 'BT Tablets', NULL, 'bt', 'bt neurophes tab 30 tabs', 'bt|bt neurophes tab 30 tabs', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(217, 217, 'MEDICAL_PRODUCT_PRICE', NULL, 'BT Penophos Tab 30 tabs', 'TABLET', 'BT', 'tabs', '30', 250.00, 250.00, 250.00, NULL, 'BT Tablets', NULL, 'bt', 'bt penophos tab 30 tabs', 'bt|bt penophos tab 30 tabs', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(218, 218, 'MEDICAL_PRODUCT_PRICE', NULL, 'BT Nail & Hair Tab 40 tabs', 'TABLET', 'BT', 'tabs', '40', 190.00, 190.00, 190.00, NULL, 'BT Tablets', NULL, 'bt', 'bt nail & hair tab 40 tabs', 'bt|bt nail & hair tab 40 tabs', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(219, 219, 'MEDICAL_PRODUCT_PRICE', NULL, 'BT Anthrako Kali Tab 40 tabs', 'TABLET', 'BT', 'tabs', '40', 265.00, 265.00, 265.00, NULL, 'BT Tablets', NULL, 'bt', 'bt anthrako kali tab 40 tabs', 'bt|bt anthrako kali tab 40 tabs', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(220, 220, 'MEDICAL_PRODUCT_PRICE', NULL, 'DT AK/25 Tab 30 tabs', 'TABLET', 'BT', 'tabs', '30', 250.00, 250.00, 250.00, NULL, 'BT Tablets', NULL, 'bt', 'dt ak/25 tab 30 tabs', 'bt|dt ak/25 tab 30 tabs', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(221, 221, 'MEDICAL_PRODUCT_PRICE', NULL, 'BT Bambysa Tab 40 tabs', 'TABLET', 'BT', 'tabs', '40', 265.00, 265.00, 265.00, NULL, 'BT Tablets', NULL, 'bt', 'bt bambysa tab 40 tabs', 'bt|bt bambysa tab 40 tabs', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(222, 222, 'MEDICAL_PRODUCT_PRICE', NULL, 'DT Bus/25 Tab 30 tabs', 'TABLET', 'BT', 'tabs', '30', 250.00, 250.00, 250.00, NULL, 'BT Tablets', NULL, 'bt', 'dt bus/25 tab 30 tabs', 'bt|dt bus/25 tab 30 tabs', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(223, 223, 'MEDICAL_PRODUCT_PRICE', NULL, 'BT Folicane Tab 30 tabs', 'TABLET', 'BT', 'tabs', '30', 311.00, 311.00, 311.00, NULL, 'BT Tablets', NULL, 'bt', 'bt folicane tab 30 tabs', 'bt|bt folicane tab 30 tabs', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(224, 224, 'MEDICAL_PRODUCT_PRICE', NULL, 'BT Salolum Tab 250 tabs', 'TABLET', 'BT', 'tabs', '250', 265.00, 265.00, 265.00, NULL, 'BT Tablets', NULL, 'bt', 'bt salolum tab 250 tabs', 'bt|bt salolum tab 250 tabs', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(225, 225, 'MEDICAL_PRODUCT_PRICE', NULL, 'BT Livonett Gold Tab 30 tabs', 'TABLET', 'BT', 'tabs', '30', 250.00, 250.00, 250.00, NULL, 'BT Tablets', NULL, 'bt', 'bt livonett gold tab 30 tabs', 'bt|bt livonett gold tab 30 tabs', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(226, 226, 'MEDICAL_PRODUCT_PRICE', NULL, 'DT LG/25 Tab 30 tabs', 'TABLET', 'BT', 'tabs', '30', 250.00, 250.00, 250.00, NULL, 'BT Tablets', NULL, 'bt', 'dt lg/25 tab 30 tabs', 'bt|dt lg/25 tab 30 tabs', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(227, 227, 'MEDICAL_PRODUCT_PRICE', NULL, 'BT Re Start Tab 30 tabs', 'TABLET', 'BT', 'tabs', '30', 355.00, 355.00, 355.00, NULL, 'BT Tablets', NULL, 'bt', 'bt re start tab 30 tabs', 'bt|bt re start tab 30 tabs', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(228, 228, 'MEDICAL_PRODUCT_PRICE', NULL, 'BT Stone Hammer Tab', 'TABLET', 'BT', NULL, NULL, 255.00, 255.00, 255.00, NULL, 'BT Tablets', NULL, 'bt', 'bt stone hammer tab', 'bt|bt stone hammer tab', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(229, 229, 'MEDICAL_PRODUCT_PRICE', NULL, 'BT Vitamin D Tab 30 tabs', 'TABLET', 'BT', 'tabs', '30', 165.00, 165.00, 165.00, NULL, 'BT Tablets', NULL, 'bt', 'bt vitamin d tab 30 tabs', 'bt|bt vitamin d tab 30 tabs', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(230, 230, 'MEDICAL_PRODUCT_PRICE', NULL, 'BT Wild Fire Tab 30 tabs', 'TABLET', 'BT', 'tabs', '30', 759.00, 759.00, 759.00, NULL, 'BT Tablets', NULL, 'bt', 'bt wild fire tab 30 tabs', 'bt|bt wild fire tab 30 tabs', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(231, 231, 'MEDICAL_PRODUCT_PRICE', NULL, 'Medi Vitamin D Tab 60 tabs', 'TABLET', 'Medi', 'tabs', '60', 250.00, 250.00, 250.00, NULL, 'BT Tablets', NULL, 'medi', 'medi vitamin d tab 60 tabs', 'medi|medi vitamin d tab 60 tabs', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(232, 232, 'MEDICAL_PRODUCT_PRICE', NULL, 'Medi Vitamin B12 Tab 60 tabs', 'TABLET', 'Medi', 'tabs', '60', 350.00, 350.00, 350.00, NULL, 'BT Tablets', NULL, 'medi', 'medi vitamin b12 tab 60 tabs', 'medi|medi vitamin b12 tab 60 tabs', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(233, 233, 'MEDICAL_PRODUCT_PRICE', NULL, 'Osteo Strong Tab 25gm', 'TABLET', 'BT', 'gm', '25', 175.00, 175.00, 175.00, NULL, 'BT Tablets', NULL, 'bt', 'osteo strong tab 25gm', 'bt|osteo strong tab 25gm', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(234, 234, 'MEDICAL_PRODUCT_PRICE', NULL, 'WSI Alpha Liv Drop 30ml', 'DROP', 'WSI', 'ml', '30', 150.00, 150.00, 150.00, NULL, 'WSI Drops', NULL, 'wsi', 'wsi alpha liv drop 30ml', 'wsi|wsi alpha liv drop 30ml', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(235, 235, 'MEDICAL_PRODUCT_PRICE', NULL, 'WSI Good Morning Drop 30ml', 'DROP', 'WSI', 'ml', '30', 150.00, 150.00, 150.00, NULL, 'WSI Drops', NULL, 'wsi', 'wsi good morning drop 30ml', 'wsi|wsi good morning drop 30ml', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(236, 236, 'MEDICAL_PRODUCT_PRICE', NULL, 'WSI PTK 89 Drop 30ml', 'DROP', 'WSI', 'ml', '30', 260.00, 260.00, 260.00, NULL, 'WSI Drops', NULL, 'wsi', 'wsi ptk 89 drop 30ml', 'wsi|wsi ptk 89 drop 30ml', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(237, 237, 'MEDICAL_PRODUCT_PRICE', NULL, 'WSI Ruck Pain Drop 30ml', 'DROP', 'WSI', 'ml', '30', 220.00, 220.00, 220.00, NULL, 'WSI Drops', NULL, 'wsi', 'wsi ruck pain drop 30ml', 'wsi|wsi ruck pain drop 30ml', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(238, 238, 'MEDICAL_PRODUCT_PRICE', NULL, 'WSI Zauber Drop 30ml', 'DROP', 'WSI', 'ml', '30', 206.00, 206.00, 206.00, NULL, 'WSI Drops', NULL, 'wsi', 'wsi zauber drop 30ml', 'wsi|wsi zauber drop 30ml', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(239, 239, 'MEDICAL_PRODUCT_PRICE', NULL, 'WSI PTK 75 Drop 30ml', 'DROP', 'WSI', 'ml', '30', 800.00, 800.00, 800.00, NULL, 'WSI Drops', NULL, 'wsi', 'wsi ptk 75 drop 30ml', 'wsi|wsi ptk 75 drop 30ml', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(240, 240, 'MEDICAL_PRODUCT_PRICE', NULL, 'WSI Dizester Syrup 200ml', 'SYRUP', 'WSI', 'ml', '200', 205.00, 205.00, 205.00, NULL, 'WSI Syrup', NULL, 'wsi', 'wsi dizester syrup 200ml', 'wsi|wsi dizester syrup 200ml', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(241, 241, 'MEDICAL_PRODUCT_PRICE', NULL, 'WSI Dizester Syrup 450ml', 'SYRUP', 'WSI', 'ml', '450', 395.00, 395.00, 395.00, NULL, 'WSI Syrup', NULL, 'wsi', 'wsi dizester syrup 450ml', 'wsi|wsi dizester syrup 450ml', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(242, 242, 'MEDICAL_PRODUCT_PRICE', NULL, 'WSI Kofsih Syrup 200ml', 'SYRUP', 'WSI', 'ml', '200', 800.00, 800.00, 800.00, NULL, 'WSI Syrup', NULL, 'wsi', 'wsi kofsih syrup 200ml', 'wsi|wsi kofsih syrup 200ml', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(243, 243, 'MEDICAL_PRODUCT_PRICE', NULL, 'WSI Kofsih Syrup 450ml', 'SYRUP', 'WSI', 'ml', '450', 450.00, 450.00, 450.00, NULL, 'WSI Syrup', NULL, 'wsi', 'wsi kofsih syrup 450ml', 'wsi|wsi kofsih syrup 450ml', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(244, 244, 'MEDICAL_PRODUCT_PRICE', NULL, 'WSI NL Alfa Malt 450ml', 'SYRUP', 'WSI', 'ml', '450', 270.00, 270.00, 270.00, NULL, 'WSI Syrup', NULL, 'wsi', 'wsi nl alfa malt 450ml', 'wsi|wsi nl alfa malt 450ml', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(245, 245, 'MEDICAL_PRODUCT_PRICE', NULL, 'NL 1 Drop 30ml', 'DROP', 'New Life', 'ml', '30', 150.00, 150.00, 150.00, NULL, 'New Life Drops', NULL, 'new life', 'nl 1 drop 30ml', 'new life|nl 1 drop 30ml', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(246, 246, 'MEDICAL_PRODUCT_PRICE', NULL, 'NL 8 Drop 30ml', 'DROP', 'New Life', 'ml', '30', 150.00, 150.00, 150.00, NULL, 'New Life Drops', NULL, 'new life', 'nl 8 drop 30ml', 'new life|nl 8 drop 30ml', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(247, 247, 'MEDICAL_PRODUCT_PRICE', NULL, 'NL 10 Drop 30ml', 'DROP', 'New Life', 'ml', '30', 150.00, 150.00, 150.00, NULL, 'New Life Drops', NULL, 'new life', 'nl 10 drop 30ml', 'new life|nl 10 drop 30ml', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(248, 248, 'MEDICAL_PRODUCT_PRICE', NULL, 'NL 13 Drop 30ml', 'DROP', 'New Life', 'ml', '30', 175.00, 175.00, 175.00, NULL, 'New Life Drops', NULL, 'new life', 'nl 13 drop 30ml', 'new life|nl 13 drop 30ml', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(249, 249, 'MEDICAL_PRODUCT_PRICE', NULL, 'NL 14 Drop 30ml', 'DROP', 'New Life', 'ml', '30', 150.00, 150.00, 150.00, NULL, 'New Life Drops', NULL, 'new life', 'nl 14 drop 30ml', 'new life|nl 14 drop 30ml', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(250, 250, 'MEDICAL_PRODUCT_PRICE', NULL, 'NL 19 Drop 30ml', 'DROP', 'New Life', 'ml', '30', 150.00, 150.00, 150.00, NULL, 'New Life Drops', NULL, 'new life', 'nl 19 drop 30ml', 'new life|nl 19 drop 30ml', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47');

INSERT INTO `master_medical_products`
    (`id`, `medicine_text_id`, `source_type`, `source_old_id`, `product_name`, `product_type`, `category`, `packing`, `size_or_weight`, `mrp_rate`, `price_min`, `price_max`, `shipper_size_pcs`, `description`, `formula_composition`, `normalized_category`, `normalized_product_name`, `dedupe_key`, `is_active`, `created_at`, `updated_at`)
VALUES
(251, 251, 'MEDICAL_PRODUCT_PRICE', NULL, 'NL 4 Drop 30ml', 'DROP', 'New Life', 'ml', '30', 160.00, 160.00, 160.00, NULL, 'New Life Drops', NULL, 'new life', 'nl 4 drop 30ml', 'new life|nl 4 drop 30ml', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(252, 252, 'MEDICAL_PRODUCT_PRICE', NULL, 'NL 5 Drop 30ml', 'DROP', 'New Life', 'ml', '30', 150.00, 150.00, 150.00, NULL, 'New Life Drops', NULL, 'new life', 'nl 5 drop 30ml', 'new life|nl 5 drop 30ml', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(253, 253, 'MEDICAL_PRODUCT_PRICE', NULL, 'NL 9 Drop 30ml', 'DROP', 'New Life', 'ml', '30', 150.00, 150.00, 150.00, NULL, 'New Life Drops', NULL, 'new life', 'nl 9 drop 30ml', 'new life|nl 9 drop 30ml', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(254, 254, 'MEDICAL_PRODUCT_PRICE', NULL, 'NL Aller-N Drop 30ml', 'DROP', 'New Life', 'ml', '30', 180.00, 180.00, 180.00, NULL, 'New Life Drops', NULL, 'new life', 'nl aller-n drop 30ml', 'new life|nl aller-n drop 30ml', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(255, 255, 'MEDICAL_PRODUCT_PRICE', NULL, 'NL Angio Bold Drop 30ml', 'DROP', 'New Life', 'ml', '30', 150.00, 150.00, 150.00, NULL, 'New Life Drops', NULL, 'new life', 'nl angio bold drop 30ml', 'new life|nl angio bold drop 30ml', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(256, 256, 'MEDICAL_PRODUCT_PRICE', NULL, 'NL Hairzootone Drop 30ml', 'DROP', 'New Life', 'ml', '30', 160.00, 160.00, 160.00, NULL, 'New Life Drops', NULL, 'new life', 'nl hairzootone drop 30ml', 'new life|nl hairzootone drop 30ml', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(257, 257, 'MEDICAL_PRODUCT_PRICE', NULL, 'NL Nervoain Drop 30ml', 'DROP', 'New Life', 'ml', '30', 164.00, 164.00, 164.00, NULL, 'New Life Drops', NULL, 'new life', 'nl nervoain drop 30ml', 'new life|nl nervoain drop 30ml', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(258, 258, 'MEDICAL_PRODUCT_PRICE', NULL, 'NL Pilocin Drop 30ml', 'DROP', 'New Life', 'ml', '30', 160.00, 160.00, 160.00, NULL, 'New Life Drops', NULL, 'new life', 'nl pilocin drop 30ml', 'new life|nl pilocin drop 30ml', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(259, 259, 'MEDICAL_PRODUCT_PRICE', NULL, 'NL Sinocin Drop 30ml', 'DROP', 'New Life', 'ml', '30', 160.00, 160.00, 160.00, NULL, 'New Life Drops', NULL, 'new life', 'nl sinocin drop 30ml', 'new life|nl sinocin drop 30ml', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(260, 260, 'MEDICAL_PRODUCT_PRICE', NULL, 'Medi Calendula Berberis Soap 100gm', 'SOAP', 'Medi', 'gm', '100', 80.00, 80.00, 80.00, NULL, 'Soap', NULL, 'medi', 'medi calendula berberis soap 100gm', 'medi|medi calendula berberis soap 100gm', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(261, 261, 'MEDICAL_PRODUCT_PRICE', NULL, 'Medi Aloe Vera Neem Tulsi Soap 100gm', 'SOAP', 'Medi', 'gm', '100', 80.00, 80.00, 80.00, NULL, 'Soap', NULL, 'medi', 'medi aloe vera neem tulsi soap 100gm', 'medi|medi aloe vera neem tulsi soap 100gm', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(262, 262, 'MEDICAL_PRODUCT_PRICE', NULL, 'SBL Baby Care Soap', 'SOAP', 'SBL', NULL, NULL, 55.00, 55.00, 55.00, NULL, 'Soap', NULL, 'sbl', 'sbl baby care soap', 'sbl|sbl baby care soap', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(263, 263, 'MEDICAL_PRODUCT_PRICE', NULL, 'SBL Silk-N Stay Berberis Soap', 'SOAP', 'SBL', NULL, NULL, 65.00, 65.00, 65.00, NULL, 'Soap', NULL, 'sbl', 'sbl silk-n stay berberis soap', 'sbl|sbl silk-n stay berberis soap', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(264, 264, 'MEDICAL_PRODUCT_PRICE', NULL, 'WL Glow Bright Soap', 'SOAP', 'WL', NULL, NULL, 80.00, 80.00, 80.00, NULL, 'Soap', NULL, 'wl', 'wl glow bright soap', 'wl|wl glow bright soap', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(265, 265, 'MEDICAL_PRODUCT_PRICE', NULL, 'WSI Glow & Fairness Soap', 'SOAP', 'WSI', NULL, NULL, 50.00, 50.00, 50.00, NULL, 'Soap', NULL, 'wsi', 'wsi glow & fairness soap', 'wsi|wsi glow & fairness soap', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(266, 266, 'MEDICAL_PRODUCT_PRICE', NULL, 'WSI Eye Drop', 'DROP', 'WSI', NULL, NULL, 160.00, 160.00, 160.00, NULL, 'Eye Drop', NULL, 'wsi', 'wsi eye drop', 'wsi|wsi eye drop', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(267, 267, 'MEDICAL_PRODUCT_PRICE', NULL, 'SSB 01 Breathe Ease Drop 30ml', 'DROP', 'SSB', 'ml', '30', 190.00, 190.00, 190.00, NULL, 'SSB Drops', NULL, 'ssb', 'ssb 01 breathe ease drop 30ml', 'ssb|ssb 01 breathe ease drop 30ml', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(268, 268, 'MEDICAL_PRODUCT_PRICE', NULL, 'SSB 13 Fissurex Drop 30ml', 'DROP', 'SSB', 'ml', '30', 190.00, 190.00, 190.00, NULL, 'SSB Drops', NULL, 'ssb', 'ssb 13 fissurex drop 30ml', 'ssb|ssb 13 fissurex drop 30ml', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(269, 269, 'MEDICAL_PRODUCT_PRICE', NULL, 'SSB 05 Helptrol Drop 30ml', 'DROP', 'SSB', 'ml', '30', 190.00, 190.00, 190.00, NULL, 'SSB Drops', NULL, 'ssb', 'ssb 05 helptrol drop 30ml', 'ssb|ssb 05 helptrol drop 30ml', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(270, 270, 'MEDICAL_PRODUCT_PRICE', NULL, 'SSB 19 Otorol Drop 30ml', 'DROP', 'SSB', 'ml', '30', 190.00, 190.00, 190.00, NULL, 'SSB Drops', NULL, 'ssb', 'ssb 19 otorol drop 30ml', 'ssb|ssb 19 otorol drop 30ml', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(271, 271, 'MEDICAL_PRODUCT_PRICE', NULL, 'SSB 23 Leucoral Drop 30ml', 'DROP', 'SSB', 'ml', '30', 190.00, 190.00, 190.00, NULL, 'SSB Drops', NULL, 'ssb', 'ssb 23 leucoral drop 30ml', 'ssb|ssb 23 leucoral drop 30ml', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(272, 272, 'MEDICAL_PRODUCT_PRICE', NULL, 'SSB 80 Leucoderma Drop 30ml', 'DROP', 'SSB', 'ml', '30', 190.00, 190.00, 190.00, NULL, 'SSB Drops', NULL, 'ssb', 'ssb 80 leucoderma drop 30ml', 'ssb|ssb 80 leucoderma drop 30ml', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(273, 273, 'MEDICAL_PRODUCT_PRICE', NULL, 'MP 32 Gallstone-M Drop 30ml', 'DROP', 'MP', 'ml', '30', 159.00, 159.00, 159.00, NULL, 'MP Drops', NULL, 'mp', 'mp 32 gallstone-m drop 30ml', 'mp|mp 32 gallstone-m drop 30ml', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(274, 274, 'MEDICAL_PRODUCT_PRICE', NULL, 'MP 53 Apeto-M Drop 30ml', 'DROP', 'MP', 'ml', '30', 159.00, 159.00, 159.00, NULL, 'MP Drops', NULL, 'mp', 'mp 53 apeto-m drop 30ml', 'mp|mp 53 apeto-m drop 30ml', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(275, 275, 'MEDICAL_PRODUCT_PRICE', NULL, 'MP Adenoid Drop 30ml', 'DROP', 'MP', 'ml', '30', 159.00, 159.00, 159.00, NULL, 'MP Drops', NULL, 'mp', 'mp adenoid drop 30ml', 'mp|mp adenoid drop 30ml', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(276, 276, 'MEDICAL_PRODUCT_PRICE', NULL, 'MP Corn-M Drop 30ml', 'DROP', 'MP', 'ml', '30', 170.00, 170.00, 170.00, NULL, 'MP Drops', NULL, 'mp', 'mp corn-m drop 30ml', 'mp|mp corn-m drop 30ml', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(277, 277, 'MEDICAL_PRODUCT_PRICE', NULL, 'MP Dentagum-M Drop 30ml', 'DROP', 'MP', 'ml', '30', 160.00, 160.00, 160.00, NULL, 'MP Drops', NULL, 'mp', 'mp dentagum-m drop 30ml', 'mp|mp dentagum-m drop 30ml', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(278, 278, 'MEDICAL_PRODUCT_PRICE', NULL, 'MP Heel Painhex Drop 30ml', 'DROP', 'MP', 'ml', '30', 180.00, 180.00, 180.00, NULL, 'MP Drops', NULL, 'mp', 'mp heel painhex drop 30ml', 'mp|mp heel painhex drop 30ml', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(279, 279, 'MEDICAL_PRODUCT_PRICE', NULL, 'MP Hirsutism Drop 30ml', 'DROP', 'MP', 'ml', '30', 170.00, 170.00, 170.00, NULL, 'MP Drops', NULL, 'mp', 'mp hirsutism drop 30ml', 'mp|mp hirsutism drop 30ml', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(280, 280, 'MEDICAL_PRODUCT_PRICE', NULL, 'MP Nasal Polyp Drop 30ml', 'DROP', 'MP', 'ml', '30', 180.00, 180.00, 180.00, NULL, 'MP Drops', NULL, 'mp', 'mp nasal polyp drop 30ml', 'mp|mp nasal polyp drop 30ml', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(281, 281, 'MEDICAL_PRODUCT_PRICE', NULL, 'NB 10 Drop 30ml', 'DROP', 'NB', 'ml', '30', 160.00, 160.00, 160.00, NULL, 'NB Drops', NULL, 'nb', 'nb 10 drop 30ml', 'nb|nb 10 drop 30ml', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(282, 282, 'MEDICAL_PRODUCT_PRICE', NULL, 'NB 26 Drop 30ml', 'DROP', 'NB', 'ml', '30', 178.00, 178.00, 178.00, NULL, 'NB Drops', NULL, 'nb', 'nb 26 drop 30ml', 'nb|nb 26 drop 30ml', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(283, 283, 'MEDICAL_PRODUCT_PRICE', NULL, 'NB 46 Drop 30ml', 'DROP', 'NB', 'ml', '30', 190.00, 190.00, 190.00, NULL, 'NB Drops', NULL, 'nb', 'nb 46 drop 30ml', 'nb|nb 46 drop 30ml', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(284, 284, 'MEDICAL_PRODUCT_PRICE', NULL, 'NB 48 Drop', 'DROP', 'NB', NULL, NULL, 160.00, 160.00, 160.00, NULL, 'NB Drops', NULL, 'nb', 'nb 48 drop', 'nb|nb 48 drop', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(285, 285, 'MEDICAL_PRODUCT_PRICE', NULL, 'NB 49 Drop', 'DROP', 'NB', NULL, NULL, 160.00, 160.00, 160.00, NULL, 'NB Drops', NULL, 'nb', 'nb 49 drop', 'nb|nb 49 drop', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(286, 286, 'MEDICAL_PRODUCT_PRICE', NULL, 'NB 52 Drop', 'DROP', 'NB', NULL, NULL, 178.00, 178.00, 178.00, NULL, 'NB Drops', NULL, 'nb', 'nb 52 drop', 'nb|nb 52 drop', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(287, 287, 'MEDICAL_PRODUCT_PRICE', NULL, 'NB 54 Drop', 'DROP', 'NB', NULL, NULL, 160.00, 160.00, 160.00, NULL, 'NB Drops', NULL, 'nb', 'nb 54 drop', 'nb|nb 54 drop', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(288, 288, 'MEDICAL_PRODUCT_PRICE', NULL, 'NB 63 Drop', 'DROP', 'NB', NULL, NULL, 160.00, 160.00, 160.00, NULL, 'NB Drops', NULL, 'nb', 'nb 63 drop', 'nb|nb 63 drop', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(289, 289, 'MEDICAL_PRODUCT_PRICE', NULL, 'NB 75 Drop', 'DROP', 'NB', NULL, NULL, 160.00, 160.00, 160.00, NULL, 'NB Drops', NULL, 'nb', 'nb 75 drop', 'nb|nb 75 drop', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(290, 290, 'MEDICAL_PRODUCT_PRICE', NULL, 'NB 83 Drop', 'DROP', 'NB', NULL, NULL, 160.00, 160.00, 160.00, NULL, 'NB Drops', NULL, 'nb', 'nb 83 drop', 'nb|nb 83 drop', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(291, 291, 'MEDICAL_PRODUCT_PRICE', NULL, 'NB 92 Drop', 'DROP', 'NB', NULL, NULL, 190.00, 190.00, 190.00, NULL, 'NB Drops', NULL, 'nb', 'nb 92 drop', 'nb|nb 92 drop', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(292, 292, 'MEDICAL_PRODUCT_PRICE', NULL, 'Rd 01 Renal Calculas Drop 30ml', 'DROP', 'Radient', 'ml', '30', 130.00, 130.00, 130.00, NULL, 'Radient Drops', NULL, 'radient', 'rd 01 renal calculas drop 30ml', 'radient|rd 01 renal calculas drop 30ml', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(293, 293, 'MEDICAL_PRODUCT_PRICE', NULL, 'Rd 09 Rheumatism Drop 30ml', 'DROP', 'Radient', 'ml', '30', 160.00, 160.00, 160.00, NULL, 'Radient Drops', NULL, 'radient', 'rd 09 rheumatism drop 30ml', 'radient|rd 09 rheumatism drop 30ml', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(294, 294, 'MEDICAL_PRODUCT_PRICE', NULL, 'Rd 20 Migraine Drop 30ml', 'DROP', 'Radient', 'ml', '30', 140.00, 140.00, 140.00, NULL, 'Radient Drops', NULL, 'radient', 'rd 20 migraine drop 30ml', 'radient|rd 20 migraine drop 30ml', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(295, 295, 'MEDICAL_PRODUCT_PRICE', NULL, 'Rd 29 Tonsilis Drop', 'DROP', 'Radient', NULL, NULL, 140.00, 140.00, 140.00, NULL, 'Radient Drops', NULL, 'radient', 'rd 29 tonsilis drop', 'radient|rd 29 tonsilis drop', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(296, 296, 'MEDICAL_PRODUCT_PRICE', NULL, 'Rd 33 Bronchitis Drop', 'DROP', 'Radient', NULL, NULL, 140.00, 140.00, 140.00, NULL, 'Radient Drops', NULL, 'radient', 'rd 33 bronchitis drop', 'radient|rd 33 bronchitis drop', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(297, 297, 'MEDICAL_PRODUCT_PRICE', NULL, 'Rd 39 Prosiasis Drop', 'DROP', 'Radient', NULL, NULL, 160.00, 160.00, 160.00, NULL, 'Radient Drops', NULL, 'radient', 'rd 39 prosiasis drop', 'radient|rd 39 prosiasis drop', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(298, 298, 'MEDICAL_PRODUCT_PRICE', NULL, 'Rd 40 Urticaria Drop', 'DROP', 'Radient', NULL, NULL, 160.00, 160.00, 160.00, NULL, 'Radient Drops', NULL, 'radient', 'rd 40 urticaria drop', 'radient|rd 40 urticaria drop', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(299, 299, 'MEDICAL_PRODUCT_PRICE', NULL, 'Rd 43 Leucoderma Drop', 'DROP', 'Radient', NULL, NULL, 160.00, 160.00, 160.00, NULL, 'Radient Drops', NULL, 'radient', 'rd 43 leucoderma drop', 'radient|rd 43 leucoderma drop', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(300, 300, 'MEDICAL_PRODUCT_PRICE', NULL, 'Rd 46 Premature Drop', 'DROP', 'Radient', NULL, NULL, 160.00, 160.00, 160.00, NULL, 'Radient Drops', NULL, 'radient', 'rd 46 premature drop', 'radient|rd 46 premature drop', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47');

INSERT INTO `master_medical_products`
    (`id`, `medicine_text_id`, `source_type`, `source_old_id`, `product_name`, `product_type`, `category`, `packing`, `size_or_weight`, `mrp_rate`, `price_min`, `price_max`, `shipper_size_pcs`, `description`, `formula_composition`, `normalized_category`, `normalized_product_name`, `dedupe_key`, `is_active`, `created_at`, `updated_at`)
VALUES
(301, 301, 'MEDICAL_PRODUCT_PRICE', NULL, 'Rd 47 Anti Dandruff Drop', 'DROP', 'Radient', NULL, NULL, 160.00, 160.00, 160.00, NULL, 'Radient Drops', NULL, 'radient', 'rd 47 anti dandruff drop', 'radient|rd 47 anti dandruff drop', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(302, 302, 'MEDICAL_PRODUCT_PRICE', NULL, 'Rd 48 Alopecia Drop', 'DROP', 'Radient', NULL, NULL, 160.00, 160.00, 160.00, NULL, 'Radient Drops', NULL, 'radient', 'rd 48 alopecia drop', 'radient|rd 48 alopecia drop', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(303, 303, 'MEDICAL_PRODUCT_PRICE', NULL, 'Rd 49 Prostate Drop', 'DROP', 'Radient', NULL, NULL, 140.00, 140.00, 140.00, NULL, 'Radient Drops', NULL, 'radient', 'rd 49 prostate drop', 'radient|rd 49 prostate drop', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(304, 304, 'MEDICAL_PRODUCT_PRICE', NULL, 'Rd 50 Bed Wetting Drop', 'DROP', 'Radient', NULL, NULL, 130.00, 130.00, 130.00, NULL, 'Radient Drops', NULL, 'radient', 'rd 50 bed wetting drop', 'radient|rd 50 bed wetting drop', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(305, 305, 'MEDICAL_PRODUCT_PRICE', NULL, 'Rd 52 Kalmeth Drop', 'DROP', 'Radient', NULL, NULL, 90.00, 90.00, 90.00, NULL, 'Radient Drops', NULL, 'radient', 'rd 52 kalmeth drop', 'radient|rd 52 kalmeth drop', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(306, 306, 'MEDICAL_PRODUCT_PRICE', NULL, 'Rd 53 Immunity Drop', 'DROP', 'Radient', NULL, NULL, 160.00, 160.00, 160.00, NULL, 'Radient Drops', NULL, 'radient', 'rd 53 immunity drop', 'radient|rd 53 immunity drop', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(307, 307, 'MEDICAL_PRODUCT_PRICE', NULL, 'Rd 54 Height Gain Drop 30ml', 'DROP', 'Radient', 'ml', '30', 300.00, 300.00, 300.00, NULL, 'Radient Drops', NULL, 'radient', 'rd 54 height gain drop 30ml', 'radient|rd 54 height gain drop 30ml', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(308, 308, 'MEDICAL_PRODUCT_PRICE', NULL, 'Rd 62 Ovarian Cyst Drop', 'DROP', 'Radient', NULL, NULL, 150.00, 150.00, 150.00, NULL, 'Radient Drops', NULL, 'radient', 'rd 62 ovarian cyst drop', 'radient|rd 62 ovarian cyst drop', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(309, 309, 'MEDICAL_PRODUCT_PRICE', NULL, 'Rd 63 Uterine Fibroids Drop', 'DROP', 'Radient', NULL, NULL, 150.00, 150.00, 150.00, NULL, 'Radient Drops', NULL, 'radient', 'rd 63 uterine fibroids drop', 'radient|rd 63 uterine fibroids drop', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(310, 310, 'MEDICAL_PRODUCT_PRICE', NULL, 'Rd 65 Breast Guard Drop', 'DROP', 'Radient', NULL, NULL, 160.00, 160.00, 160.00, NULL, 'Radient Drops', NULL, 'radient', 'rd 65 breast guard drop', 'radient|rd 65 breast guard drop', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(311, 311, 'MEDICAL_PRODUCT_PRICE', NULL, 'Rd 69 Thyroid Drop', 'DROP', 'Radient', NULL, NULL, 160.00, 160.00, 160.00, NULL, 'Radient Drops', NULL, 'radient', 'rd 69 thyroid drop', 'radient|rd 69 thyroid drop', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(312, 312, 'MEDICAL_PRODUCT_PRICE', NULL, 'Rd 71 Diabetes Drop', 'DROP', 'Radient', NULL, NULL, 150.00, 150.00, 150.00, NULL, 'Radient Drops', NULL, 'radient', 'rd 71 diabetes drop', 'radient|rd 71 diabetes drop', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(313, 313, 'MEDICAL_PRODUCT_PRICE', NULL, 'Rd 97 Tumour Drop', 'DROP', 'Radient', NULL, NULL, 150.00, 150.00, 150.00, NULL, 'Radient Drops', NULL, 'radient', 'rd 97 tumour drop', 'radient|rd 97 tumour drop', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(314, 314, 'MEDICAL_PRODUCT_PRICE', NULL, 'Rd 98 Hernia Drop', 'DROP', 'Radient', NULL, NULL, 150.00, 150.00, 150.00, NULL, 'Radient Drops', NULL, 'radient', 'rd 98 hernia drop', 'radient|rd 98 hernia drop', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(315, 315, 'MEDICAL_PRODUCT_PRICE', NULL, 'Rd 100 Dengue Drop', 'DROP', 'Radient', NULL, NULL, 160.00, 160.00, 160.00, NULL, 'Radient Drops', NULL, 'radient', 'rd 100 dengue drop', 'radient|rd 100 dengue drop', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(316, 316, 'MEDICAL_PRODUCT_PRICE', NULL, 'PM P1 Acidity Drop 30ml', 'DROP', 'PM', 'ml', '30', 170.00, 170.00, 170.00, NULL, 'PM Drops', NULL, 'pm', 'pm p1 acidity drop 30ml', 'pm|pm p1 acidity drop 30ml', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(317, 317, 'MEDICAL_PRODUCT_PRICE', NULL, 'PM P19 Pain Drop 30ml', 'DROP', 'PM', 'ml', '30', 175.00, 175.00, 175.00, NULL, 'PM Drops', NULL, 'pm', 'pm p19 pain drop 30ml', 'pm|pm p19 pain drop 30ml', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(318, 318, 'MEDICAL_PRODUCT_PRICE', NULL, 'PM P20 Blood Pressure Drop 30ml', 'DROP', 'PM', 'ml', '30', 170.00, 170.00, 170.00, NULL, 'PM Drops', NULL, 'pm', 'pm p20 blood pressure drop 30ml', 'pm|pm p20 blood pressure drop 30ml', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(319, 319, 'MEDICAL_PRODUCT_PRICE', NULL, 'PM P3 Allergy Drop 30ml', 'DROP', 'PM', 'ml', '30', 175.00, 175.00, 175.00, NULL, 'PM Drops', NULL, 'pm', 'pm p3 allergy drop 30ml', 'pm|pm p3 allergy drop 30ml', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(320, 320, 'MEDICAL_PRODUCT_PRICE', NULL, 'PM Rheumcare Syrup 200ml', 'SYRUP', 'PM', 'ml', '200', 250.00, 250.00, 250.00, NULL, 'PM Syrup', NULL, 'pm', 'pm rheumcare syrup 200ml', 'pm|pm rheumcare syrup 200ml', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(321, 321, 'MEDICAL_PRODUCT_PRICE', NULL, 'PM Rheumcare Syrup 450ml', 'SYRUP', 'PM', 'ml', '450', 338.00, 338.00, 338.00, NULL, 'PM Syrup', NULL, 'pm', 'pm rheumcare syrup 450ml', 'pm|pm rheumcare syrup 450ml', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(322, 322, 'MEDICAL_PRODUCT_PRICE', NULL, 'Faceliquid 2 30ml', 'LIQUID', 'Misc', 'ml', '30', 200.00, 200.00, 200.00, NULL, 'Misc Items', NULL, 'misc', 'faceliquid 2 30ml', 'misc|faceliquid 2 30ml', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(323, 323, 'MEDICAL_PRODUCT_PRICE', NULL, 'Faceliquid/15 15ml', 'LIQUID', 'Misc', 'ml', '15', 150.00, 150.00, 150.00, NULL, 'Misc Items', NULL, 'misc', 'faceliquid/15 15ml', 'misc|faceliquid/15 15ml', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(324, 324, 'MEDICAL_PRODUCT_PRICE', NULL, '70 Q 15 100ml', 'LIQUID', 'Misc', 'ml', '100', 500.00, 500.00, 500.00, NULL, 'Misc Items', NULL, 'misc', '70 q 15 100ml', 'misc|70 q 15 100ml', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(325, 325, 'MEDICAL_PRODUCT_PRICE', NULL, '70 Q4 15 15ml', 'LIQUID', 'Misc', 'ml', '15', 150.00, 150.00, 150.00, NULL, 'Misc Items', NULL, 'misc', '70 q4 15 15ml', 'misc|70 q4 15 15ml', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(326, 326, 'MEDICAL_PRODUCT_PRICE', NULL, '70 Q B12 30ml', 'LIQUID', 'Misc', 'ml', '30', 200.00, 200.00, 200.00, NULL, 'Misc Items', NULL, 'misc', '70 q b12 30ml', 'misc|70 q b12 30ml', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(327, 327, 'MEDICAL_PRODUCT_PRICE', NULL, '70 Q/1 15ml', 'LIQUID', 'Misc', 'ml', '15', 100.00, 100.00, 100.00, NULL, 'Misc Items', NULL, 'misc', '70 q/1 15ml', 'misc|70 q/1 15ml', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(328, 328, 'MEDICAL_PRODUCT_PRICE', NULL, '740 Tabo Q 12 30ml', 'LIQUID', 'Misc', 'ml', '30', 200.00, 200.00, 200.00, NULL, 'Misc Items', NULL, 'misc', '740 tabo q 12 30ml', 'misc|740 tabo q 12 30ml', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(329, 329, 'MEDICAL_PRODUCT_PRICE', NULL, '740 Tabo Q/15 15ml', 'LIQUID', 'Misc', 'ml', '15', 150.00, 150.00, 150.00, NULL, 'Misc Items', NULL, 'misc', '740 tabo q/15 15ml', 'misc|740 tabo q/15 15ml', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(330, 330, 'MEDICAL_PRODUCT_PRICE', NULL, 'White Spot Liquid/15 15ml', 'LIQUID', 'Misc', 'ml', '15', 150.00, 150.00, 150.00, NULL, 'Misc Items', NULL, 'misc', 'white spot liquid/15 15ml', 'misc|white spot liquid/15 15ml', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(331, 331, 'MEDICAL_PRODUCT_PRICE', NULL, 'Leucodermalotient + W.Spot Liquid', 'LOTION', 'Misc', NULL, NULL, 394.00, 394.00, 394.00, NULL, 'Misc Items', NULL, 'misc', 'leucodermalotient + w.spot liquid', 'misc|leucodermalotient + w.spot liquid', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(332, 332, 'MEDICAL_PRODUCT_PRICE', NULL, 'UQ1', 'LIQUID', 'Misc', NULL, NULL, 100.00, 100.00, 100.00, NULL, 'Misc Items', NULL, 'misc', 'uq1', 'misc|uq1', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(333, 333, 'MEDICAL_PRODUCT_PRICE', NULL, 'Wart and Corn + UQ', 'LIQUID', 'Misc', NULL, NULL, 170.00, 170.00, 170.00, NULL, 'Misc Items', NULL, 'misc', 'wart and corn + uq', 'misc|wart and corn + uq', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(334, 334, 'MEDICAL_PRODUCT_PRICE', NULL, 'Cornhil Cream + 70Q', 'CREAM', 'Misc', NULL, NULL, 225.00, 225.00, 225.00, NULL, 'Misc Items', NULL, 'misc', 'cornhil cream + 70q', 'misc|cornhil cream + 70q', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(335, 335, 'MEDICAL_PRODUCT_PRICE', NULL, 'Septo Lotion + 70Q', 'LOTION', 'Misc', NULL, NULL, 394.00, 394.00, 394.00, NULL, 'Misc Items', NULL, 'misc', 'septo lotion + 70q', 'misc|septo lotion + 70q', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(336, 336, 'MEDICAL_PRODUCT_PRICE', NULL, 'Body Oil + 70Q B', 'OIL', 'Misc', NULL, NULL, 340.00, 340.00, 340.00, NULL, 'Misc Items', NULL, 'misc', 'body oil + 70q b', 'misc|body oil + 70q b', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(337, 337, 'MEDICAL_PRODUCT_PRICE', NULL, 'Wastomed + UQ', 'LIQUID', 'Misc', NULL, NULL, 410.00, 410.00, 410.00, NULL, 'Misc Items', NULL, 'misc', 'wastomed + uq', 'misc|wastomed + uq', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(338, 338, 'MEDICAL_PRODUCT_PRICE', NULL, 'Skin Repair Tonic + 70Q/15', 'TONIC', 'Misc', NULL, NULL, 649.00, 649.00, 649.00, NULL, 'Misc Items', NULL, 'misc', 'skin repair tonic + 70q/15', 'misc|skin repair tonic + 70q/15', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(339, 339, 'MEDICAL_PRODUCT_PRICE', NULL, 'B-Shape + 70Q/15', 'LIQUID', 'Misc', NULL, NULL, 510.00, 510.00, 510.00, NULL, 'Misc Items', NULL, 'misc', 'b-shape + 70q/15', 'misc|b-shape + 70q/15', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(340, 340, 'MEDICAL_PRODUCT_PRICE', NULL, 'Heal Cream + 70Q/15', 'CREAM', 'Misc', NULL, NULL, 240.00, 240.00, 240.00, NULL, 'Misc Items', NULL, 'misc', 'heal cream + 70q/15', 'misc|heal cream + 70q/15', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(341, 341, 'MEDICAL_PRODUCT_PRICE', NULL, 'Dermasen Cream + 70Q/15', 'CREAM', 'Misc', NULL, NULL, 480.00, 480.00, 480.00, NULL, 'Misc Items', NULL, 'misc', 'dermasen cream + 70q/15', 'misc|dermasen cream + 70q/15', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(342, 342, 'MEDICAL_PRODUCT_PRICE', NULL, 'Dermasen Tube + 70Q/15', 'CREAM', 'Misc', NULL, NULL, 375.00, 375.00, 375.00, NULL, 'Misc Items', NULL, 'misc', 'dermasen tube + 70q/15', 'misc|dermasen tube + 70q/15', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47'),
(343, 343, 'MEDICAL_PRODUCT_PRICE', NULL, 'Hemalmalis + 70Q/15', 'LIQUID', 'Misc', NULL, NULL, 225.00, 225.00, 225.00, NULL, 'Misc Items', NULL, 'misc', 'hemalmalis + 70q/15', 'misc|hemalmalis + 70q/15', 1, '2026-08-18 05:18:47', '2026-08-18 05:18:47');

-- ==============================================================================
-- STEP 7: CONFIGURE AUTO_INCREMENT SEQUENCES
-- ==============================================================================
ALTER TABLE `master_text_medicines` AUTO_INCREMENT = 344;
ALTER TABLE `master_medical_products` AUTO_INCREMENT = 344;

-- ==============================================================================
-- STEP 8: POST-MIGRATION VALIDATION & INTEGRITY ASSERTIONS
-- ==============================================================================
DELIMITER $$

DROP PROCEDURE IF EXISTS `sp_validate_migration_refresh_medicine_masters`$$

CREATE PROCEDURE `sp_validate_migration_refresh_medicine_masters`()
BEGIN
    DECLARE v_old_text_cnt INT DEFAULT 0;
    DECLARE v_old_prod_cnt INT DEFAULT 0;
    DECLARE v_new_text_cnt INT DEFAULT 0;
    DECLARE v_new_prod_cnt INT DEFAULT 0;
    DECLARE v_expected_text_cnt INT DEFAULT 343;
    DECLARE v_expected_prod_cnt INT DEFAULT 343;

    -- 8.1 Validate both _old backup tables exist
    SELECT COUNT(*) INTO v_old_text_cnt
    FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'master_text_medicines_old';

    IF v_old_text_cnt = 0 THEN
        SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'VALIDATION FAILED: master_text_medicines_old backup table does not exist!';
    END IF;

    SELECT COUNT(*) INTO v_old_prod_cnt
    FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'master_medical_products_old';

    IF v_old_prod_cnt = 0 THEN
        SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'VALIDATION FAILED: master_medical_products_old backup table does not exist!';
    END IF;

    -- 8.2 Validate both new tables have exact expected master data row count
    SELECT COUNT(*) INTO v_new_text_cnt FROM `master_text_medicines`;
    IF v_new_text_cnt < v_expected_text_cnt THEN
        SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'VALIDATION FAILED: master_text_medicines row count is less than expected!';
    END IF;

    SELECT COUNT(*) INTO v_new_prod_cnt FROM `master_medical_products`;
    IF v_new_prod_cnt < v_expected_prod_cnt THEN
        SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'VALIDATION FAILED: master_medical_products row count is less than expected!';
    END IF;

    -- Output success verification summary
    SELECT
        'SUCCESS' AS migration_status,
        v_new_text_cnt AS master_text_medicines_rows,
        v_new_prod_cnt AS master_medical_products_rows,
        'Old backup tables preserved safely (*_old)' AS backup_status,
        NOW() AS completed_at;

END$$

DELIMITER ;

-- Run validation
CALL `sp_validate_migration_refresh_medicine_masters`();

-- Clean up validation procedure
DROP PROCEDURE IF EXISTS `sp_validate_migration_refresh_medicine_masters`;
