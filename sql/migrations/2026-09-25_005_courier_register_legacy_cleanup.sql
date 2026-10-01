UPDATE tbl_courier_deliveries
SET tracking_no = NULL
WHERE LOWER(TRIM(COALESCE(tracking_no, ''))) IN ('', 'null', 'undefined');
