ALTER TABLE `tbl_bill_items`
  ADD COLUMN `consultation_test_id` BIGINT UNSIGNED NULL AFTER `consultation_medication_id`,
  ADD COLUMN `item_type` ENUM('MEDICATION', 'ADDITIONAL_MEDICATION', 'TEST') NOT NULL DEFAULT 'MEDICATION' AFTER `consultation_test_id`,
  ADD KEY `idx_tbl_bill_items_consultation_test` (`consultation_test_id`),
  ADD CONSTRAINT `fk_tbl_bill_items_consultation_test`
    FOREIGN KEY (`consultation_test_id`) REFERENCES `tbl_consultation_tests` (`id`);
