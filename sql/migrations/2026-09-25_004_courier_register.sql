CREATE TABLE IF NOT EXISTS tbl_courier_deliveries (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  bill_id BIGINT UNSIGNED NOT NULL,
  status ENUM('NEEDS_REVIEW', 'READY_TO_DISPATCH', 'DISPATCHED', 'DELIVERED', 'RETURNED', 'CANCELLED') NOT NULL DEFAULT 'READY_TO_DISPATCH',
  courier_partner VARCHAR(120) NULL,
  tracking_no VARCHAR(120) NULL,
  dispatch_remark VARCHAR(255) NULL,
  return_reason VARCHAR(255) NULL,
  dispatched_at DATETIME NULL,
  delivered_at DATETIME NULL,
  returned_at DATETIME NULL,
  created_by BIGINT UNSIGNED NULL,
  updated_by BIGINT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_courier_deliveries_bill (bill_id),
  KEY idx_courier_deliveries_status (status, updated_at),
  CONSTRAINT fk_courier_deliveries_bill FOREIGN KEY (bill_id) REFERENCES tbl_bills (id),
  CONSTRAINT fk_courier_deliveries_created_by FOREIGN KEY (created_by) REFERENCES master_users (id),
  CONSTRAINT fk_courier_deliveries_updated_by FOREIGN KEY (updated_by) REFERENCES master_users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS tbl_courier_delivery_events (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  courier_delivery_id BIGINT UNSIGNED NOT NULL,
  from_status VARCHAR(30) NULL,
  to_status VARCHAR(30) NOT NULL,
  note VARCHAR(255) NULL,
  actor_user_id BIGINT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_courier_delivery_events_delivery (courier_delivery_id, created_at),
  CONSTRAINT fk_courier_delivery_events_delivery FOREIGN KEY (courier_delivery_id) REFERENCES tbl_courier_deliveries (id),
  CONSTRAINT fk_courier_delivery_events_actor FOREIGN KEY (actor_user_id) REFERENCES master_users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT INTO tbl_courier_deliveries
  (bill_id, status, tracking_no, dispatch_remark, created_by, updated_by, created_at, updated_at)
SELECT
  b.id,
  'NEEDS_REVIEW',
  NULLIF(TRIM(JSON_UNQUOTE(JSON_EXTRACT(b.delivery_details_json, '$.tracking_no'))), ''),
  'Imported from existing courier bill; confirm dispatch status',
  b.created_by,
  b.updated_by,
  b.created_at,
  b.updated_at
FROM tbl_bills b
WHERE b.bill_type = 'MEDICATION'
  AND b.status = 'ACTIVE'
  AND b.delivery_mode = 'COURIER'
ON DUPLICATE KEY UPDATE bill_id = VALUES(bill_id);

INSERT INTO tbl_courier_delivery_events
  (courier_delivery_id, from_status, to_status, note, actor_user_id, created_at)
SELECT
  cd.id,
  NULL,
  'NEEDS_REVIEW',
  'Imported from existing courier bill',
  cd.created_by,
  cd.created_at
FROM tbl_courier_deliveries cd
LEFT JOIN tbl_courier_delivery_events e ON e.courier_delivery_id = cd.id
WHERE cd.status = 'NEEDS_REVIEW'
  AND e.id IS NULL;
