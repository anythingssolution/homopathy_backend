ALTER TABLE `tbl_bills`
  ADD COLUMN `delivery_mode` VARCHAR(30) NOT NULL DEFAULT 'HAND_DELIVERY' AFTER `remark`,
  ADD COLUMN `delivery_details_json` JSON NULL AFTER `delivery_mode`;

ALTER TABLE `tbl_bills`
  ADD KEY `idx_tbl_bills_delivery_mode` (`delivery_mode`);
