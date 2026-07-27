CREATE TABLE IF NOT EXISTS `master_medical_products` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `medicine_text_id` BIGINT UNSIGNED DEFAULT NULL,
  `source_type` ENUM('REGULAR_PRODUCT', 'RADIENT_PHARMA', 'MEDICAL_PRODUCT_PRICE') NOT NULL,
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
  `description` TEXT DEFAULT NULL,
  `formula_composition` TEXT DEFAULT NULL,
  `normalized_category` VARCHAR(120) DEFAULT NULL,
  `normalized_product_name` VARCHAR(255) NOT NULL,
  `dedupe_key` VARCHAR(700) NOT NULL,
  `is_active` TINYINT(1) NOT NULL DEFAULT 1,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_master_medical_products_source_dedupe` (`source_type`, `dedupe_key`),
  KEY `idx_master_medical_products_medicine_text` (`medicine_text_id`),
  KEY `idx_master_medical_products_source` (`source_type`),
  KEY `idx_master_medical_products_normalized_name` (`normalized_product_name`),
  CONSTRAINT `fk_master_medical_products_medicine_text`
    FOREIGN KEY (`medicine_text_id`) REFERENCES `master_text_medicines` (`id`)
    ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

INSERT IGNORE INTO `master_medical_products`
  (`medicine_text_id`, `source_type`, `source_old_id`, `product_name`, `product_type`,
   `packing`, `mrp_rate`, `normalized_product_name`, `dedupe_key`, `is_active`,
   `created_at`, `updated_at`)
SELECT
  `medicine_text_id`,
  'REGULAR_PRODUCT',
  `id`,
  `product_name`,
  `product_type`,
  `packing`,
  `mrp_rate`,
  `normalized_product_name`,
  CONCAT_WS('|', `normalized_product_name`, COALESCE(`packing`, ''), COALESCE(`product_type`, '')),
  `is_active`,
  `created_at`,
  `updated_at`
FROM `master_products`;

INSERT IGNORE INTO `master_medical_products`
  (`medicine_text_id`, `source_type`, `source_old_id`, `product_name`, `category`,
   `size_or_weight`, `mrp_rate`, `shipper_size_pcs`, `description`,
   `formula_composition`, `normalized_product_name`, `dedupe_key`, `is_active`,
   `created_at`, `updated_at`)
SELECT
  `medicine_text_id`,
  'RADIENT_PHARMA',
  `id`,
  `product_name`,
  `category`,
  `net_weight_or_size`,
  `mrp_rate`,
  `shipper_size_pcs`,
  `description`,
  `formula_composition`,
  `normalized_product_name`,
  CONCAT_WS('|', `normalized_product_name`, COALESCE(`net_weight_or_size`, ''), COALESCE(`category`, '')),
  `is_active`,
  `created_at`,
  `updated_at`
FROM `master_products_radient_pharma`;

INSERT IGNORE INTO `master_medical_products`
  (`medicine_text_id`, `source_type`, `source_old_id`, `product_name`, `category`,
   `price_min`, `price_max`, `normalized_category`,
   `normalized_product_name`, `dedupe_key`, `is_active`, `created_at`, `updated_at`)
SELECT
  `medicine_text_id`,
  'MEDICAL_PRODUCT_PRICE',
  `id`,
  `product_name`,
  `category`,
  `price_min`,
  `price_max`,
  `normalized_category`,
  `normalized_product_name`,
  CONCAT_WS('|', COALESCE(`normalized_category`, ''), `normalized_product_name`),
  `is_active`,
  `created_at`,
  `updated_at`
FROM `master_handwritten_product_prices`;

RENAME TABLE
  `master_products` TO `old_master_products`,
  `master_products_radient_pharma` TO `old_master_products_radient_pharma`,
  `master_handwritten_product_prices` TO `old_master_handwritten_product_prices`;
