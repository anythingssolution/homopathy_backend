const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { buildBillListReadSql } = require('../services/billListReadService');

// Execute both SQL shapes over the same fixture. These expressions deliberately
// retain the previous controller's allocation rules as the comparison baseline.
const legacyAggregates = `
    COALESCE((SELECT SUM(i.amount) FROM tbl_bill_items i WHERE i.bill_id = b.bill_id AND i.item_type = 'TEST'), 0) AS test_amount,
    COALESCE((SELECT SUM(i.amount) FROM tbl_bill_items i WHERE i.bill_id = b.bill_id AND LOWER(i.item_name) = 'courier charge'), 0) AS courier_amount,
    (SELECT bp.payment_mode FROM tbl_bill_payments bp WHERE bp.bill_id = b.bill_id AND bp.status = 'SUCCESS' ORDER BY bp.id DESC LIMIT 1) AS payment_mode,
    COALESCE((SELECT SUM(bp.amount) FROM tbl_bill_payments bp WHERE bp.status = 'SUCCESS' AND UPPER(bp.payment_mode) = 'CASH'
        AND (bp.settlement_source_bill_id = b.bill_id OR (bp.settlement_source_bill_id IS NULL AND bp.bill_id = b.bill_id))), 0) AS cash_amount,
    COALESCE((SELECT SUM(bp.amount) FROM tbl_bill_payments bp WHERE bp.status = 'SUCCESS' AND UPPER(bp.payment_mode) = 'ONLINE'
        AND (bp.settlement_source_bill_id = b.bill_id OR (bp.settlement_source_bill_id IS NULL AND bp.bill_id = b.bill_id))), 0) AS online_amount,
    COALESCE((SELECT SUM(bp.amount) FROM tbl_bill_payments bp WHERE bp.bill_id = b.bill_id AND bp.status = 'SUCCESS'
        AND COALESCE(bp.allocation_kind, 'CURRENT') <> 'PREVIOUS'), 0) AS paid_towards_this_bill,
    COALESCE((SELECT SUM(bp.amount) FROM tbl_bill_payments bp WHERE bp.settlement_source_bill_id = b.bill_id AND bp.bill_id <> b.bill_id
        AND bp.status = 'SUCCESS' AND bp.allocation_kind = 'PREVIOUS'), 0) AS paid_towards_previous_pending,
    COALESCE((SELECT SUM(bp.amount) FROM tbl_bill_payments bp WHERE bp.bill_id = b.bill_id AND bp.status = 'SUCCESS'
        AND bp.allocation_kind = 'PREVIOUS'), 0) AS borrowed_amount_collected`;

const orderSql = `ORDER BY CASE WHEN appointment_id IS NULL THEN created_at ELSE actual_completed_at END DESC,
    appointment_date DESC, start_time ASC, token_number ASC, bill_id DESC`;

const fixture = () => {
    const db = new DatabaseSync(':memory:');
    db.exec(`CREATE TABLE bills (
        bill_id INTEGER PRIMARY KEY, appointment_id INTEGER, created_at TEXT,
        actual_completed_at TEXT, appointment_date TEXT, start_time TEXT, token_number INTEGER
    );
    CREATE TABLE tbl_bill_items (bill_id INTEGER, item_type TEXT, item_name TEXT, amount NUMERIC);
    CREATE TABLE tbl_bill_payments (
        id INTEGER PRIMARY KEY, bill_id INTEGER, settlement_source_bill_id INTEGER,
        status TEXT, allocation_kind TEXT, payment_mode TEXT, amount NUMERIC
    );
    INSERT INTO bills VALUES
        (1, 101, '2026-09-01 08:00:00', '2026-09-01 09:00:00', '2026-09-01', '08:00:00', 2),
        (2, NULL, '2026-09-16 10:00:00', NULL, '2026-09-16', NULL, NULL),
        (3, 103, '2026-09-16 08:00:00', '2026-09-16 11:00:00', '2026-09-16', '08:00:00', 4),
        (4, 104, '2026-09-16 08:00:00', '2026-09-16 11:00:00', '2026-09-16', '08:00:00', 5),
        (5, 105, '2026-09-16 08:00:00', NULL, '2026-09-16', '08:00:00', 6);
    INSERT INTO tbl_bill_items VALUES
        (2, 'MEDICINE', 'Syrup', 120.25), (2, 'TEST', 'CBC', 50.5),
        (2, 'TEST', 'TSH', 60), (2, 'DELIVERY', 'Courier Charge', 40),
        (2, 'DELIVERY', 'courier charge', 5.5), (1, 'TEST', 'Old test', 30);
    INSERT INTO tbl_bill_payments VALUES
        (1, 1, NULL, 'SUCCESS', NULL, 'CASH', 100),
        (2, 1, 2, 'SUCCESS', 'PREVIOUS', 'CASH', 50.5),
        (3, 2, 2, 'SUCCESS', 'CURRENT', 'ONLINE', 150.25),
        (4, 2, NULL, 'SUCCESS', 'CURRENT', 'cash', 20),
        (5, 2, 2, 'SUCCESS', 'PREVIOUS', 'CASH', 30),
        (6, 1, 2, 'FAILED', 'PREVIOUS', 'CASH', 9999),
        (7, 2, 3, 'SUCCESS', 'PREVIOUS', 'ONLINE', 10),
        (8, 2, NULL, 'FAILED', 'CURRENT', 'ONLINE', 9999),
        (9, 3, NULL, 'SUCCESS', NULL, NULL, 5),
        (10, 2, NULL, 'SUCCESS', 'PREVIOUS', 'ONLINE', 12);`);
    return db;
};

const queryPair = (db, suffix) => {
    const legacy = db.prepare(`SELECT b.*, ${legacyAggregates} FROM bills b ${suffix}`).all();
    const optimized = db.prepare(buildBillListReadSql(`SELECT * FROM bills ${suffix}`)).all();
    assert.deepEqual(optimized, legacy);
    return optimized;
};

test('batched bill aggregates preserve current, previous, self-source and failed-payment semantics', () => {
    const db = fixture();
    try {
        const rows = queryPair(db, `${orderSql} LIMIT 1000 OFFSET 0`);
        const repeat = rows.find((row) => row.bill_id === 2);
        assert.equal(repeat.test_amount, 110.5);
        assert.equal(repeat.courier_amount, 45.5);
        assert.equal(repeat.cash_amount, 100.5);
        assert.equal(repeat.online_amount, 162.25);
        assert.equal(repeat.paid_towards_this_bill, 170.25);
        assert.equal(repeat.paid_towards_previous_pending, 50.5);
        assert.equal(repeat.borrowed_amount_collected, 52);
        assert.equal(repeat.payment_mode, 'ONLINE');
        assert.equal(rows.find((row) => row.bill_id === 3).payment_mode, null);
        assert.equal(rows.find((row) => row.bill_id === 4).cash_amount, 0);
    } finally { db.close(); }
});

test('bill page totals include allocations linked to bills outside the selected page', () => {
    const db = fixture();
    try {
        const rows = queryPair(db, `WHERE bill_id = 2 ${orderSql} LIMIT 1000 OFFSET 0`);
        assert.equal(rows.length, 1);
        assert.equal(rows[0].paid_towards_previous_pending, 50.5);
        const empty = queryPair(db, `WHERE bill_id = 999 ${orderSql} LIMIT 1000 OFFSET 0`);
        assert.equal(empty.length, 0);
    } finally { db.close(); }
});

test('bill aggregation preserves appointment/direct ordering and each page boundary', () => {
    const db = fixture();
    try {
        const first = queryPair(db, `${orderSql} LIMIT 2 OFFSET 0`);
        const second = queryPair(db, `${orderSql} LIMIT 2 OFFSET 2`);
        const third = queryPair(db, `${orderSql} LIMIT 2 OFFSET 4`);
        assert.deepEqual([...first, ...second, ...third].map((row) => row.bill_id), [3, 4, 2, 1, 5]);
    } finally { db.close(); }
});
