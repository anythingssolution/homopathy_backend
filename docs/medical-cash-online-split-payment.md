# Medical cash + online split payment

Medical staff can collect **part cash and part online** while dispensing (and on Repeat Medicine). This file covers how that money is stored in the backend and how it appears on **Bills**.

Related work in the same flow:

- Previous pending / borrowed allocation (`allocation_kind` CURRENT vs PREVIOUS)
- Manual SQL for teammates: `sql/2026-08-26_bill_payment_pending_allocation.sql`
- Migration: `sql/migrations/2026-08-26_001_bill_payment_pending_allocation.sql`

---

## What the medical user does

On **Dispense → Confirm & Mark as Dispensed** (same panel on Repeat Medicine):

1. Leave **Pay cash and online** unchecked to collect in one mode (Cash **or** Online), as before.
2. Tick **Pay cash and online** to split the collect total.
3. Type **Cash** or **Online** — the other field fills in so both add up to **Collect today** (or today + previous pending if that box is ticked).
4. If Online is greater than 0, **Transaction reference** (UPI / Paytm / Card txn ID) is required.
5. Removing a medicine or test updates the collect total; Cash / Online rebalance in real time.
6. Mouse wheel does not change the amount fields; typing or the spinner arrows do.

Cash is applied first, then online. Today’s bill is paid first. Extra money goes to older borrowed bills only if **Also collect previous pending** is ticked.

---

## Request payload

`POST /api/v1/medical/prescriptions/:consultation_id/pricing`  
`POST /api/v1/medical/repeat-medicine/bills`

### Single mode (unchanged)

```json
{
  "payment": {
    "payment_mode": "CASH",
    "amount": 1200,
    "transaction_reference": null,
    "remark": null,
    "allocation_order": "CURRENT_ONLY"
  }
}
```

Online uses `"payment_mode": "ONLINE"` and a required `transaction_reference`.

`allocation_order`:

- `CURRENT_ONLY` — only today’s bill (default unless previous pending is ticked)
- `CURRENT_FIRST` — today first, leftover to oldest previous medication bills

### Split cash + online

```json
{
  "payment": {
    "split": true,
    "cash_amount": 800,
    "online_amount": 400,
    "amount": 1200,
    "transaction_reference": "UPI123456",
    "remark": null,
    "allocation_order": "CURRENT_ONLY"
  }
}
```

The API also accepts `payment.payments[]` with `{ payment_mode, amount, transaction_reference }` per part.

Parser: `normalizeMedicalPaymentPayload` in `controllers/v1/medicalController.js`.

---

## How the backend stores it

`MIXED` is **not** a stored payment mode. Each collection is still `CASH` or `ONLINE` on `tbl_bill_payments`. A bill looks mixed when it has **both** kinds of success rows.

### 1. Normalize

Split payload becomes two parts, cash first, then online. Zero amounts are dropped. Online with amount > 0 must have a transaction reference.

### 2. Apply in order

`applyMedicationReceipts` in `services/patientCreditService.js` loops those parts and calls `applyMedicationReceipt` for each one **inside the same transaction**.

Because pending is updated after each part:

| Collect | Today due | Previous due | Result |
|---------|-----------|--------------|--------|
| Cash ₹800 + Online ₹400, today ₹1200 | ₹1200 | ₹0 | Today: ₹800 CASH + ₹400 ONLINE. Bill paid. |
| Cash ₹400 + Online ₹300, today ₹600, previous ₹500, `CURRENT_FIRST` | ₹600 | ₹500 | Cash ₹400 → today. Online ₹300 → today ₹200 + previous ₹100. |
| Cash ₹400 + Online ₹300, today ₹600, `CURRENT_ONLY` | ₹600 | ignored | Same as paying ₹700 on today only; extra over today is rejected. |
| Both amounts 0 | full today | unchanged | No payment rows. Today stays unpaid / borrowed. |

### 3. One payment row per bill touched, per mode

`collectBillPayment` inserts into `tbl_bill_payments`:

| Column | Meaning |
|--------|---------|
| `payment_mode` | `CASH` or `ONLINE` |
| `amount` | Slice applied to that bill |
| `transaction_reference` | Required on ONLINE rows |
| `allocation_kind` | `CURRENT` = this visit’s bill, `PREVIOUS` = older borrowed bill |
| `settlement_source_bill_id` | Visit where the money was collected (today’s bill) |
| `pending_before` / `pending_after` | Pending on the **target** bill around this row |

Example: today ₹600, previous bill A ₹500, cash ₹400 + online ₹300, previous pending ticked:

| Row | bill | mode | amount | allocation_kind |
|-----|------|------|--------|-----------------|
| 1 | Today | CASH | 400 | CURRENT |
| 2 | Today | ONLINE | 200 | CURRENT |
| 3 | Bill A | ONLINE | 100 | PREVIOUS |

Bill A’s paid-from-this-visit amount shows on today’s Bills row as **Paid Borrowed Amount**.

---

## How it shows on Bills (`/bills`)

UI: `homopathy_frontend/src/components/dashboard/Bills.tsx`

### Appointment Bills List

Each row is one visit. **Payment Mode** uses the **latest** success payment on that visit’s bills (`ORDER BY bp.id DESC LIMIT 1`).

So a cash+online visit often shows **ONLINE** (online is written second), not a stored `MIXED` value. The badge can show `MIXED` if the list ever receives that string; the list API currently does not derive it.

**Paid Borrowed Amount** (green) is previous pending collected **during this visit** (`paid_towards_previous_pending`). Empty is **—**.

### Open visit (bill detail)

Payments are listed **row by row**:

- Amount + **CASH** or **ONLINE**
- Transaction reference / note
- Collected at
- **Towards this bill** vs **Previous pending / borrowed** (`allocation_kind`, pending before/after)

If extra money settled older bills, **Previous pending paid with this bill** lists those settlements.

Receptionist/medical **Collect remaining** on an open bill is still one mode (Cash or Online). Split on collect-remaining was not added; split is on medical dispense / repeat medicine.

### Revenue by Consultant / Medicine

Consultant revenue **Mode** is `MIXED` when that doctor’s bills in the period have **more than one** distinct payment mode (`revenueByConsultant.js`). That is how cash+online shows up in the report tables.

---

## Files

| Area | File |
|------|------|
| Dispense UI | `homopathy_frontend/src/components/dashboard/MedicationDuePaymentPanel.tsx` |
| Dispense submit | `homopathy_frontend/src/components/dashboard/MedicalDashboard.tsx` |
| Repeat medicine | `homopathy_frontend/src/components/dashboard/RepeatMedicine.tsx` |
| Payload helper | `homopathy_frontend/src/utils/medicationDues.ts` |
| Bills UI | `homopathy_frontend/src/components/dashboard/Bills.tsx` |
| Parse + apply on pricing | `homopathy_backend/controllers/v1/medicalController.js` |
| Allocate + write payments | `homopathy_backend/services/patientCreditService.js` |
| Insert payment row | `homopathy_backend/services/billingService.js` |
| Bills list aggregates | `homopathy_backend/controllers/v1/billController.js` |
| Report MIXED | `homopathy_backend/services/reports/billing/revenueByConsultant.js` |

---

## Quick checks

1. Dispense ₹1200 as ₹800 cash + ₹400 online with txn ID → two `tbl_bill_payments` rows on today’s medication bill.
2. Open the visit on Bills → two lines, CASH and ONLINE, both “Towards this bill”.
3. Tick previous pending, collect more than today → extra rows with `allocation_kind = PREVIOUS`; Bills list shows Paid Borrowed Amount.
4. Revenue by Consultant → Mode **MIXED** for that doctor if both modes exist in the date range.
