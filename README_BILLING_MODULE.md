# Billing Module README

Ye document consultation + medication billing flow, new APIs, aur unke business reasons explain karta hai.

## Why billing module add kiya gaya?

Updated business flow ke hisaab se:

1. patient appointment book karta hai
2. consultation bill auto-create hota hai
3. receptionist appointment approve karte time full consultation fee collect karti hai
4. payment mode `CASH` ya `ONLINE` save hota hai
5. doctor appointment list dekh sakta hai, lekin consultation create/start ke liye payment + approval rules apply hote hain
6. medical pricing ke basis par medication bill create hota hai

Isliye alag billing APIs aur tables add ki gayi hain.

---

## Required migration

- `sql/2026-05-12_billing_consultation_payment.sql`

---

## New/Updated APIs

### 1) Create consultation bill

```http
POST /api/v1/bills/consultation
```

### Why?

Ye API consultation bill create karti hai agar booking flow me bill missing ho. Normal flow me appointment booking par bill auto-create ho jata hai, but manual recovery / admin-safe creation ke liye endpoint rakha gaya hai.

### Request body

```json
{
  "appointment_id": 12
}
```

### Postman steps

1. Method `POST`
2. URL:
   - `http://localhost:3000/api/v1/bills/consultation`
3. Header:
   - `Authorization: Bearer <token>`
   - `Content-Type: application/json`
4. Body → `raw` → `JSON`
5. Upar wala JSON paste karo
6. Send

### Role access

- `patient` (sirf apne appointment ke liye)
- `receptionist`

---

### 2) Collect consultation payment

```http
PATCH /api/v1/bills/consultation/:bill_id/collect-payment
```

### Why?

Ye dedicated payment endpoint isliye add ki gayi hai:

- receptionist-booked approved appointments ke liye bhi payment later collect ki ja sake
- consultation bill ka payment record alag maintain ho
- cash/online mode aur transaction reference store ho

### Request body

```json
{
  "payment_mode": "CASH",
  "amount": 500,
  "transaction_reference": null,
  "remark": "Collected at desk"
}
```

Online example:

```json
{
  "payment_mode": "ONLINE",
  "amount": 500,
  "transaction_reference": "UPI-123456",
  "remark": "Paid by UPI"
}
```

### Postman steps

1. Method `PATCH`
2. URL:
   - `http://localhost:3000/api/v1/bills/consultation/15/collect-payment`
3. Header:
   - `Authorization: Bearer <RECEPTIONIST_TOKEN>`
   - `Content-Type: application/json`
4. Body → `raw` → `JSON`
5. Cash ya online payload paste karo
6. Send

### Validation

- only receptionist
- full pending amount hi collect hoga
- `ONLINE` mode me `transaction_reference` required hai

---

### 3) Create medication bill

```http
POST /api/v1/bills/medication
```

### Why?

Medical pricing aur bill same cheez nahi hain. Pricing workflow medical module me rehta hai, but bill patient/doctor/medical visibility ke liye separate record chahiye. Ye API saved pricing se medication bill banati hai.

### Request body

```json
{
  "consultation_id": 21,
  "remark": "Medication bill generated from saved pricing"
}
```

### Postman steps

1. Method `POST`
2. URL:
   - `http://localhost:3000/api/v1/bills/medication`
3. Header:
   - `Authorization: Bearer <MEDICAL_TOKEN>`
   - `Content-Type: application/json`
4. Body → `raw` → `JSON`
5. Upar wala JSON paste karo
6. Send

### Role access

- `medical`

---

### 4) Get bills list

```http
GET /api/v1/bills
```

### Why?

Single role-aware endpoint se:

- patient → apne consultation/medication bills
- doctor → sab bills
- receptionist → sirf consultation bills
- medical → sirf medication bills

### Optional query params

- `type=CONSULTATION|MEDICATION`
- `payment_status=UNPAID|PAID|PARTIAL`
- `appointment_id`
- `patient_id`

### Example URLs

```http
GET /api/v1/bills
```

```http
GET /api/v1/bills?type=CONSULTATION&payment_status=UNPAID
```

```http
GET /api/v1/bills?type=MEDICATION&patient_id=12
```

### Postman steps

1. Method `GET`
2. URL:
   - `http://localhost:3000/api/v1/bills`
3. Header:
   - `Authorization: Bearer <token>`
4. Agar filter chahiye to `Params` tab me add karo
5. Send

---

### 5) Get single bill detail

```http
GET /api/v1/bills/:bill_id
```

### Why?

Bill detail me summary ke saath:

- payments array
- medication items array
- appointment/patient context

mil jata hai.

### Example

```http
GET /api/v1/bills/15
```

### Postman steps

1. Method `GET`
2. URL:
   - `http://localhost:3000/api/v1/bills/15`
3. Header:
   - `Authorization: Bearer <token>`
4. Send

---

## Receptionist approval flow change

### New preferred endpoint

```http
POST /api/v1/receptionist/appointments/:appointment_id/approve-and-collect-payment
```

### Why new API?

Approval aur payment ko single transaction me rakhne ke liye. Agar payment fail ho to approval nahi hota. Isse consultation start karne se pehle billing state consistent rehti hai.

### Legacy alias

```http
POST /api/v1/receptionist/appointments/:appointment_id/approve
```

Ab ye bhi same payment payload demand karta hai.

### Request body pattern

```json
{
  "payment_mode": "CASH",
  "amount": 500,
  "transaction_reference": null,
  "remark": "Consultation fee collected at approval time"
}
```

Online:

```json
{
  "payment_mode": "ONLINE",
  "amount": 500,
  "transaction_reference": "TXN-987654",
  "remark": "Collected via online payment"
}
```

### Postman steps

1. Method `POST`
2. URL:
   - `http://localhost:3000/api/v1/receptionist/appointments/12/approve-and-collect-payment`
3. Header:
   - `Authorization: Bearer <RECEPTIONIST_TOKEN>`
   - `Content-Type: application/json`
4. Body → `raw` → `JSON`
5. Cash ya online payload paste karo
6. Send

---

## New tables / fields

### `master_treatments`

- `consultation_fee`

### `tbl_appointments`

- `consultation_payment_status`
- `consultation_bill_id`
- `payment_collected_at`
- `payment_collected_by`

### `tbl_bills`

- consultation + medication bill master

### `tbl_bill_payments`

- cash/online payment entries

### `tbl_bill_items`

- medication bill line items

---

## Visibility rule

Doctor consultation queue me ab sirf wahi appointment dikhega jiska:

- `reception_status = APPROVED_BY_RECEPTION`
- `consultation_payment_status = PAID`

Ye rule doctor appointment list, doctor single appointment detail, aur doctor consultation creation tino jagah enforce kiya gaya hai.

---

## Files updated

- `controllers/v1/appointmentController.js`
- `controllers/v1/receptionistController.js`
- `controllers/v1/doctorController.js`
- `controllers/v1/billController.js`
- `routes/v1/receptionistRoutes.js`
- `routes/v1/billRoutes.js`
- `services/billingService.js`
- `sql/2026-05-12_billing_consultation_payment.sql`

---

## Summary

Billing module ab:

- consultation bill auto-create karta hai
- receptionist approval ke time payment capture karta hai
- cash/online mode store karta hai
- consultation start/create se pehle paid/approval rules enforce karta hai
- medication pricing se medication bill create karta hai
