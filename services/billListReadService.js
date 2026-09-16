// The inner query owns authorization, filtering, ordering and pagination. Its LIMIT
// keeps this materialized page small before reading its item/payment aggregates.
const buildBillListReadSql = (pageSql) => `WITH page_bills AS (
    ${pageSql}
), page_bill_ids AS (
    SELECT DISTINCT bill_id FROM page_bills
), item_totals AS (
    SELECT i.bill_id,
        SUM(CASE WHEN i.item_type = 'TEST' THEN i.amount ELSE 0 END) AS test_amount,
        SUM(CASE WHEN LOWER(i.item_name) = 'courier charge' THEN i.amount ELSE 0 END) AS courier_amount
    FROM page_bill_ids ids
    JOIN tbl_bill_items i ON i.bill_id = ids.bill_id
    GROUP BY i.bill_id
), own_payments AS (
    SELECT bp.bill_id,
        MAX(bp.id) AS latest_payment_id,
        SUM(CASE WHEN bp.settlement_source_bill_id IS NULL AND UPPER(bp.payment_mode) = 'CASH'
            THEN bp.amount ELSE 0 END) AS cash_amount,
        SUM(CASE WHEN bp.settlement_source_bill_id IS NULL AND UPPER(bp.payment_mode) = 'ONLINE'
            THEN bp.amount ELSE 0 END) AS online_amount,
        SUM(CASE WHEN COALESCE(bp.allocation_kind, 'CURRENT') <> 'PREVIOUS'
            THEN bp.amount ELSE 0 END) AS paid_towards_this_bill,
        SUM(CASE WHEN bp.allocation_kind = 'PREVIOUS'
            THEN bp.amount ELSE 0 END) AS borrowed_amount_collected
    FROM page_bill_ids ids
    JOIN tbl_bill_payments bp ON bp.bill_id = ids.bill_id
    WHERE bp.status = 'SUCCESS'
    GROUP BY bp.bill_id
), source_payments AS (
    SELECT bp.settlement_source_bill_id AS bill_id,
        SUM(CASE WHEN UPPER(bp.payment_mode) = 'CASH' THEN bp.amount ELSE 0 END) AS cash_amount,
        SUM(CASE WHEN UPPER(bp.payment_mode) = 'ONLINE' THEN bp.amount ELSE 0 END) AS online_amount,
        SUM(CASE WHEN bp.bill_id <> bp.settlement_source_bill_id AND bp.allocation_kind = 'PREVIOUS'
            THEN bp.amount ELSE 0 END) AS paid_towards_previous_pending
    FROM page_bill_ids ids
    JOIN tbl_bill_payments bp ON bp.settlement_source_bill_id = ids.bill_id
    WHERE bp.status = 'SUCCESS'
    GROUP BY bp.settlement_source_bill_id
)
SELECT page_bills.*,
    COALESCE(item_totals.test_amount, 0) AS test_amount,
    COALESCE(item_totals.courier_amount, 0) AS courier_amount,
    latest_payment.payment_mode,
    COALESCE(own_payments.cash_amount, 0) + COALESCE(source_payments.cash_amount, 0) AS cash_amount,
    COALESCE(own_payments.online_amount, 0) + COALESCE(source_payments.online_amount, 0) AS online_amount,
    COALESCE(own_payments.paid_towards_this_bill, 0) AS paid_towards_this_bill,
    COALESCE(source_payments.paid_towards_previous_pending, 0) AS paid_towards_previous_pending,
    COALESCE(own_payments.borrowed_amount_collected, 0) AS borrowed_amount_collected
FROM page_bills
LEFT JOIN item_totals ON item_totals.bill_id = page_bills.bill_id
LEFT JOIN own_payments ON own_payments.bill_id = page_bills.bill_id
LEFT JOIN source_payments ON source_payments.bill_id = page_bills.bill_id
LEFT JOIN tbl_bill_payments latest_payment ON latest_payment.id = own_payments.latest_payment_id
ORDER BY CASE WHEN page_bills.appointment_id IS NULL THEN page_bills.created_at
    ELSE page_bills.actual_completed_at END DESC,
    page_bills.appointment_date DESC,
    page_bills.start_time ASC,
    page_bills.token_number ASC,
    page_bills.bill_id DESC`;

module.exports = { buildBillListReadSql };
