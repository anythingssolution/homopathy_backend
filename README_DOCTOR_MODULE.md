# Doctor Module API README

Ye document doctor module ke implemented APIs, validation rules, aur Postman se in APIs ko hit karne ka practical flow explain karta hai.

## Base URL

Local example:

```text
http://localhost:3000/api/v1
```

Doctor module ka base path:

```text
http://localhost:3000/api/v1/doctors
```

## Important Notes

- Doctor module ke sabhi APIs me **doctor login token** required hai.
- Header me hamesha ye bhejna hoga:

```text
Authorization: Bearer <DOCTOR_ACCESS_TOKEN>
```

- Role access: `doctor` only
- Consultation save karne se appointment ka status `Completed` ho jata hai.
- Consultation save karne se live queue state bhi `COMPLETED` ho jati hai aur realtime queue event emit hota hai.
- Doctor presence/session ke liye ab separate backend support hai:
  - doctor authenticated session controls
  - public doctor status API
  - public realtime socket namespace
  - detailed audit logs
- One appointment → one consultation
- One consultation → multiple medicines
- Har medicine ke liye row-wise multiple `doses` support hai; each dose me alag balls count save ho sakta hai.
- Live token display/queue ke liye `current_token_number` primary field maana jaye.
- UI display ke liye backend ab `token_display` / `current_token_display` / `original_token_display` bhi return karta hai. Morning slot token `M-1` aur evening slot token `E-1` pattern follow karega.
- New preferred patient-facing token field: `display_token_display`
- New live queue metadata:
  - `checked_in_at`
  - `arrival_sequence`
  - `queue_bucket`
  - `live_queue_position`
- Full live queue runtime APIs/documentation: `README_LIVE_QUEUE_REALTIME.md`
- Family-member booking support ke baad:
  - `patient_full_name` visiting patient / dependent ko represent karta hai
  - `primary_patient_full_name` account holder name deta hai
  - `booked_for_type` aur `family_member_relationship` bhi appointment payload me available hain

## Database Setup for Doctor Consultation

Doctor consultation APIs chalane se pehle ye migration run karein:

- `sql/2026-05-06_doctor_consultations.sql`
- live queue enable karna ho to additionally `sql/2026-05-14_live_queue_realtime.sql`
- dynamic live queue positioning ke liye additionally:
  - `sql/2026-05-19_live_queue_dynamic_positions.sql`
- doctor live session / public status ke liye additionally:
- `sql/2026-05-19_doctor_live_sessions.sql`
- family member booking support ke liye additionally:
  - `sql/2026-05-20_family_member_booking.sql`
- branch-wise doctor leave calendar ke liye additionally:
  - `sql/2026-05-23_branch_doctor_leaves.sql`

## Why backend behavior changed

- doctor UI ko ab ready patients aur not-arrived patients alag milte hain
- patient token stable dikh sake isliye display token original booking token se derive hota hai
- realtime “next patient” handling ke liye backend protected `call-next` flow support karta hai

## Pause session rule with consultation form

Important backend rule:

- **consult form open** hona consultation start nahi maana jayega
- pause/resume behavior persisted queue state ke basis par chalega, UI-open form ke basis par nahi

### If doctor pauses before consultation actually starts

Yaani:

- form open hai
- but appointment `IN_PROGRESS` nahi hua

To backend:

- doctor session ko pause karega
- live queue session ko `PAUSED` karega
- current running appointment ko clear rakhega
- patient ko ready/called state me hi chhodega

### If doctor pauses after consultation started

Yaani appointment already `IN_PROGRESS` hai:

- doctor session pause hoga
- current patient preserve hoga
- resume ke baad same patient continue ho sakta hai

Ye rule queue inconsistency avoid karne ke liye implement kiya gaya hai.

Is migration se ye tables create hongi:

- `tbl_consultations`
- `tbl_consultation_medications`
- `tbl_medication_dosages` (row-wise dose schedule)

## Doctor Module API List

1. `GET /api/v1/doctors/dashboard`
2. `GET /api/v1/doctors/patient`
3. `GET /api/v1/doctors/reports`
4. `GET /api/v1/doctors/masters/text-medicines`
5. `GET /api/v1/doctors/appointments`
6. `GET /api/v1/doctors/appointments/:appointment_id`
7. `GET /api/v1/doctors/consultations-history`
8. `GET /api/v1/doctors/billed-prescriptions`
9. `POST /api/v1/doctors/session/start`
10. `POST /api/v1/doctors/session/pause`
11. `GET /api/v1/doctors/session/logs`
12. `GET /api/v1/doctors/leaves`
13. `POST /api/v1/doctors/leaves`
14. `POST /api/v1/doctors/leaves/bulk`
15. `DELETE /api/v1/doctors/leaves/:leave_id`
16. `POST /api/v1/doctors/leaves/bulk-cancel`
17. `GET /api/v1/public/doctor-status`
18. `GET /api/v1/public/doctor-booking-availability`
19. `POST /api/v1/doctors/consultations`
20. `GET /api/v1/doctors/consultations/:appointment_id`

---

## Doctor Live Session / Public Status Flow

Ye flow doctor ke **Start Session** aur **Pause Session** buttons ko backend source-of-truth banata hai.

### Goal

- Doctor portal se session start / pause karna
- Sab authenticated modules ko realtime update bhejna
- Public/non-auth pages ko safe doctor status dikhana
- Audit logs maintain karna

### Source of truth

DB tables:

- `tbl_doctor_live_sessions`
- `tbl_doctor_live_session_logs`

### Realtime transport

- Authenticated namespace: default Socket.IO connection
- Public namespace: `/public-status`

### Public initial-load strategy

Public ya non-auth screens initial state ke liye:

```http
GET /api/v1/public/doctor-status
```

Uske baad realtime ke liye socket namespace:

```text
/public-status
```

### Booking rule clarification

- `GET /api/v1/public/doctor-status` **display/status** use-case ke liye hai
- booking allow/block ka source-of-truth ab leave calendar hai
- agar branch/date par **active leave** hai to booking blocked
- agar leave **cancelled** hai to booking allowed
- doctor ne session start nahi kiya ho tab bhi booking allowed rahegi

### Realtime events

- initial connect event:
  - `doctor.session.current`
- update event:
  - `doctor.session.updated`
- doctor appointment list live refresh event:
  - `doctor.appointments.updated`

### Public response shape

```json
{
  "success": true,
  "message": "Public doctor status fetched successfully",
  "data": {
    "is_doctor_available": true,
    "status": "IN",
    "label": "Doctor In",
    "time": "2026-05-19 10:15:00",
    "started_at": "2026-05-19 10:15:00",
    "ended_at": null,
    "doctor_name": "Dr. Trivedi",
    "branch_name": "Main Branch"
  }
}
```

### `time` field meaning

- if status = `IN` → `time = started_at`
- if status = `OUT` → `time = ended_at`

### Logging model

Har start / pause action log table me save hota hai with:

- old/new status
- action
- branch
- actor
- role
- IP
- user agent
- note
- timestamp

### Doctor appointment list realtime update

Doctor portal ki appointment list ko live refresh karne ke liye backend ab booking creation ke time authenticated doctor sockets ko ye event emit karta hai:

```text
doctor.appointments.updated
```

Ye event dono flows par emit hota hai:

- patient self booking
- receptionist booking

Example payload:

```json
{
  "reason": "APPOINTMENT_CREATED",
  "source": "PATIENT_BOOKING",
  "appointment": {
    "appointment_id": 28,
    "auid": "AUID190520260002",
    "fk_branch_id": 1,
    "branch_name": "Main Branch",
    "fk_treatment_id": 1,
    "treatment_name": "Homeopathy Consultation",
    "fk_slot_id": 2,
    "slot_name": "Morning Slot",
    "token_number": 5,
    "appointment_date": "2026-05-19",
    "status": "Pending",
    "reception_status": "PENDING_AT_RECEPTION",
    "consultation_payment_status": "UNPAID",
    "patient_full_name": "Rahul Sahu",
    "patient_mobile_no": "9876543210"
  }
}
```

Doctor frontend is event ko listen karke:

- direct row insert kar sakta hai
- ya current filters ke hisaab se list re-fetch kar sakta hai

---

## 1) Doctor Login for Token

Doctor APIs hit karne se pehle token lena hoga.

### Endpoint

```http
POST /api/v1/auth/login
```

ya

```http
POST /api/v1/auth/login/password
```

### Body

```json
{
  "mobile_no": "9876543210",
  "password": "secret123"
}
```

### Postman me kaise hit karein

1. Postman open karein
2. Method `POST` select karein
3. URL dalein:
   - `http://localhost:3000/api/v1/auth/login`
4. `Body` tab → `raw` → `JSON`
5. Upar wala JSON paste karein
6. Send karein
7. Response se `token` copy karein
8. Agle sab doctor APIs me header me use karein:

```text
Authorization: Bearer <token>
```

---

## 1A) Start Doctor Session

Doctor portal se doctor ko available mark karne ke liye.

### Endpoint

```http
POST /api/v1/doctors/session/start
```

### Headers

```text
Authorization: Bearer <DOCTOR_ACCESS_TOKEN>
Content-Type: application/json
```

### Body

```json
{
  "branch_id": 1,
  "note": "Doctor reached clinic"
}
```

### Behavior

- same doctor ka already active `IN` session ho to duplicate row create nahi hoti
- naya session row `tbl_doctor_live_sessions` me create hota hai
- audit row `tbl_doctor_live_session_logs` me create hoti hai
- realtime event emit hota hai:
  - `doctor.session.updated`

### Success Response Example

```json
{
  "success": true,
  "message": "Doctor session started successfully",
  "data": {
    "is_doctor_available": true,
    "status": "IN",
    "label": "Doctor In",
    "time": "2026-05-19 10:15:00",
    "started_at": "2026-05-19 10:15:00",
    "ended_at": null,
    "doctor_name": "Dr. Trivedi",
    "branch_name": "Main Branch",
    "session_id": 3,
    "doctor_id": 1,
    "branch_id": 1,
    "source": "MANUAL",
    "updated_at": "2026-05-19 10:15:00"
  }
}
```

---

## 1B) Pause Doctor Session

Doctor portal se doctor ko unavailable / out mark karne ke liye.

### Endpoint

```http
POST /api/v1/doctors/session/pause
```

### Headers

```text
Authorization: Bearer <DOCTOR_ACCESS_TOKEN>
Content-Type: application/json
```

### Body

```json
{
  "note": "Lunch break"
}
```

### Behavior

- currently active `IN` session ko `OUT` me update karta hai
- `ended_at` fill hota hai
- audit log insert hota hai
- realtime event emit hota hai:
  - `doctor.session.updated`

### Success Response Example

```json
{
  "success": true,
  "message": "Doctor session paused successfully",
  "data": {
    "is_doctor_available": false,
    "status": "OUT",
    "label": "Doctor Out",
    "time": "2026-05-19 13:40:00",
    "started_at": "2026-05-19 10:15:00",
    "ended_at": "2026-05-19 13:40:00",
    "doctor_name": "Dr. Trivedi",
    "branch_name": "Main Branch"
  }
}
```

---

## 1C) Doctor Session Logs

Doctor ke session actions ka audit trail dekhne ke liye.

### Endpoint

```http
GET /api/v1/doctors/session/logs
```

### Query Params (optional)

- `from_date` → `YYYY-MM-DD`
- `to_date` → `YYYY-MM-DD`
- `limit` → positive integer, max 500

### Example

```http
GET /api/v1/doctors/session/logs?from_date=2026-05-19&to_date=2026-05-19&limit=50
```

### Response Example

```json
{
  "success": true,
  "data": [
    {
      "log_id": 9,
      "doctor_session_id": 3,
      "doctor_id": 1,
      "doctor_name": "Dr. Trivedi",
      "branch_id": 1,
      "branch_name": "Main Branch",
      "old_status": "IN",
      "new_status": "OUT",
      "action": "PAUSE_SESSION",
      "note": "Lunch break",
      "changed_by_user_id": 1,
      "changed_by_role": "DOC",
      "source": "MANUAL",
      "ip_address": "::1",
      "user_agent": "Mozilla/5.0 ...",
      "created_at": "2026-05-19 13:40:00"
    }
  ]
}
```

---

## 1D) Public Doctor Status

Ye **unauthenticated** endpoint hai. Public pages, booking page, navbar, patient-side widgets isko use kar sakte hain.

### Endpoint

```http
GET /api/v1/public/doctor-status
```

### Query Params (optional)

- `doctor_id` → specific doctor ke liye
- `branch_id` → specific branch ke liye

### Example

```http
GET /api/v1/public/doctor-status
```

```http
GET /api/v1/public/doctor-status?doctor_id=1&branch_id=1
```

### Socket Namespace

```text
/public-status
```

### Public socket initial event

```text
doctor.session.current
```

### Update event

```text
doctor.session.updated
```

### Notes

- public endpoint sirf safe display data deta hai
- internal actor / IP / audit metadata public response me expose nahi hota
- public UI initial load par GET use kare aur baad me socket updates listen kare
- booking allow/block is endpoint se decide nahi karna chahiye

---

## 1E) Doctor Leave Calendar APIs

Ye APIs doctor ko apni selected branch ke liye leave dates manage karne deti hain.

### 1E.1) Get leave dates for a month

```http
GET /api/v1/doctors/leaves?month=2026-05
```

Notes:

- authenticated doctor only
- selected branch scope auto-apply hota hai
- response me sirf `ACTIVE` leave rows aati hain

### 1E.2) Save single leave date

```http
POST /api/v1/doctors/leaves
```

Body:

```json
{
  "branch_id": 1,
  "leave_date": "2026-05-28",
  "leave_reason": "Personal leave"
}
```

### 1E.3) Save multiple leave dates

```http
POST /api/v1/doctors/leaves/bulk
```

Body:

```json
{
  "branch_id": 1,
  "leave_dates": ["2026-05-28", "2026-05-29", "2026-05-30"],
  "leave_reason": "Out of station"
}
```

### 1E.4) Cancel single leave date

```http
DELETE /api/v1/doctors/leaves/12
```

### 1E.5) Cancel multiple leave dates

```http
POST /api/v1/doctors/leaves/bulk-cancel
```

Body:

```json
{
  "branch_id": 1,
  "leave_dates": ["2026-05-28", "2026-05-29"]
}
```

### Leave behavior notes

- one doctor + one branch + one date par ek hi leave row maintain hoti hai
- cancel ka matlab row delete nahi hoti; status `CANCELLED` ho jata hai
- cancelled leave ke baad booking **allow** honi chahiye

---

## 1F) Public Doctor Booking Availability

Booking page / receptionist booking page ke liye:

```http
GET /api/v1/public/doctor-booking-availability?branch_id=1&date=2026-05-28
```

### Behavior

- active leave present → `booking_enabled = false`
- leave cancelled / leave absent → `booking_enabled = true`
- doctor session `IN/OUT` response me informational `live_status` ke roop me aa sakta hai, but booking block rule ka part nahi hai

---

## 2) Get Doctor Appointments List

Doctor patient appointments list dekh sakta hai.

> Is API me ab **sirf current date aur future date** ke appointments hi aayenge. Past appointments response me nahi bheje jayenge.
> Is API me appointment list dekhne ke liye receptionist approval ya consultation payment mandatory nahi hai.
> Lekin consultation create/start karne ke liye backend me approval + payment restrictions ab bhi enforced hain.

### Endpoint

```http
GET /api/v1/doctors/appointments
```

### Query Params (optional)

- `branch_id` → positive integer
- `appointment_date` → `YYYY-MM-DD`
- `status` → `Pending | Confirmed | Completed | Cancelled`
- `patient_search` → patient name / mobile / uuid
- `include_consulted=true` → already consulted appointments bhi include karne ke liye

### Example URLs

```http
GET /api/v1/doctors/appointments
```

```http
GET /api/v1/doctors/appointments?appointment_date=2026-05-10&status=Pending
```

```http
GET /api/v1/doctors/appointments?branch_id=1&patient_search=rahul
```

### Postman me kaise hit karein

1. New request banayein
2. Method `GET`
3. URL:
   - `http://localhost:3000/api/v1/doctors/appointments`
4. `Authorization` tab → `Bearer Token`
5. Token paste karein
6. Agar filters chahiye to `Params` tab me add karein:
   - key: `appointment_date`, value: `2026-05-10`
   - key: `status`, value: `Pending`
7. Send karein

### Success Response Example

```json
{
  "success": true,
  "message": "Doctor appointments fetched successfully",
  "data": [
    {
      "appointment_id": 12,
      "auid": "AUID060520260001",
      "branch_name": "Main Branch",
      "treatment_name": "Migraine Treatment",
      "slot_name": "Morning Slot",
      "token_number": 4,
      "appointment_date": "2026-05-10",
      "status": "Pending",
      "consultation_payment_status": "PAID",
      "patient_full_name": "Rahul Sahu",
      "patient_mobile_no": "9876543210"
    }
  ],
  "meta": {
    "filters": {
      "branch_id": null,
      "appointment_date": "2026-05-10",
      "status": "Pending",
      "patient_search": null
    },
    "total": 1
  }
}
```

### Workflow Effect

Doctor consultation save/finalize hote hi backend ab:

- consultation `workflow_status` ko direct `READY_FOR_MEDICAL` set karta hai
- `doctor_finalized_at` set karta hai
- `sent_to_medical_at` set karta hai
- medical role ko direct notification / socket event bhejta hai

Receptionist approval ab prescription workflow ka part nahi hai. Receptionist sirf read-only list/detail dekh sakta hai.

---

## 2A) Get Doctor Dashboard

Doctor home/dashboard screen ke liye combined summary API.

### Endpoint

```http
GET /api/v1/doctors/dashboard
```

### Query Params (optional)

- `date` → `YYYY-MM-DD`
- `branch_id` → positive integer

### Postman me kaise hit karein

1. Method `GET`
2. URL:
   - `http://localhost:3000/api/v1/doctors/dashboard`
3. `Authorization` → `Bearer Token`
4. Optional `Params`:
   - `date=2026-05-06`
   - `branch_id=1`
5. Send karein

### Response me kya milega

- summary counts
- branch summary
- upcoming appointments
- recent consultations

---

## 2B) Get Doctor Patients List

---

## 2C) Get Doctor Billed Prescriptions List

Medical team ne jinke bills/amount save kar diye hain, un prescriptions ki list doctor is API se dekh sakta hai.

### Endpoint

```http
GET /api/v1/doctors/billed-prescriptions
```

### Query Params (optional)

- `branch_id` → positive integer
- `from_date` → `YYYY-MM-DD`
- `to_date` → `YYYY-MM-DD`
- `patient_search` → patient name / mobile / uuid

### Example URLs

```http
GET /api/v1/doctors/billed-prescriptions
```

```http
GET /api/v1/doctors/billed-prescriptions?from_date=2026-05-01&to_date=2026-05-08
```

```http
GET /api/v1/doctors/billed-prescriptions?branch_id=1&patient_search=rahul
```

### Response me kya milega

- appointment details
- patient details
- consultation details
- medical pricing details

### Postman me kaise hit karein

1. Method `GET`
2. URL:
   - `http://localhost:3000/api/v1/doctors/billed-prescriptions`
3. `Authorization` → `Bearer Token`
4. Optional params add karein
5. Send karein

Doctor ke liye patient listing API.

### Endpoint

```http
GET /api/v1/doctors/patient
```

### Query Params (optional)

- `branch_id` → positive integer
- `search` → patient name / mobile / uuid
- `type` → `all | recent | followup_pending`

### Example

```http
GET /api/v1/doctors/patient?search=rahul&type=recent
```

### Postman me kaise hit karein

1. Method `GET`
2. URL:
   - `http://localhost:3000/api/v1/doctors/patient`
3. `Authorization` → `Bearer Token`
4. `Params` me filter add karein if needed
5. Send karein

---

## 2C) Get Doctor Reports

Doctor reporting/analytics ke liye common API.

### Endpoint

```http
GET /api/v1/doctors/reports
```

### Query Params (optional)

- `type` → `summary | branch | treatment | consultation | patient`
- `from` → `YYYY-MM-DD`
- `to` → `YYYY-MM-DD`
- `branch_id` → positive integer

### Example

```http
GET /api/v1/doctors/reports?type=branch&from=2026-05-01&to=2026-05-31
```

### Postman me kaise hit karein

1. Method `GET`
2. URL:
   - `http://localhost:3000/api/v1/doctors/reports`
3. `Authorization` → `Bearer Token`
4. `Params` add karein
5. Send karein

---

## 2D) Get Text Medicine Masters

Doctor ke liye text medicine names, text medicine remarks, aur linked product/pricing masters ek hi API me.
Consultation form open hote hi frontend is API ko trigger kar sakta hai.

### Endpoint

```http
GET /api/v1/doctors/masters/text-medicines
```

### Response Includes

- `text_medicines`
- `text_medicine_remarks`

Har `text_medicines[]` item ke andar ye linked arrays aate hain:

- `medical_products` → `master_medical_products`
- `products` → `master_medical_products` filtered by `source_type = REGULAR_PRODUCT`
- `radient_pharma_products` → `master_medical_products` filtered by `source_type = RADIENT_PHARMA`
- `handwritten_product_prices` → `master_medical_products` filtered by `source_type = MEDICAL_PRODUCT_PRICE`

`products`, `radient_pharma_products`, aur `handwritten_product_prices` keys backward compatibility ke liye response me maintain hain. New integrations ke liye `medical_products` use karna preferred hai.

Backend response me normalized helper columns intentionally nahi bheje jaate:

- `normalized_value`
- `normalized_product_name`
- `normalized_category`

Relation priority:

1. `medicine_text_id` se exact relation use hota hai.
2. Agar old import data me `medicine_text_id` null ho, to backend `normalized_product_name` ko `master_text_medicines.normalized_value` se match karke fallback relation banata hai.

### Frontend Consultation Flow

1. Doctor consultation page/component mount hote hi:
   - `GET /api/v1/doctors/masters/text-medicines`
   - `Authorization: Bearer <doctor-token>`
2. `data.text_medicines` ko text/custom medicine autocomplete ke source ke roop me use karein.
3. Jab doctor koi text medicine select kare, us selected medicine object ke nested arrays se related product/pricing choices show karein:
   - `selectedMedicine.medical_products` (preferred)
   - `selectedMedicine.products`
   - `selectedMedicine.radient_pharma_products`
   - `selectedMedicine.handwritten_product_prices`
4. Frontend ko normalized fields handle/filter karne ki zarurat nahi hai, kyunki backend unhe response me send nahi karta.
5. Existing consultation submit payload break nahi hota. Doctor ab bhi `medicine_type: "TEXT"` ke saath `medicine_value`, `remark`, aur `amount` send karega.

### Success Response Example

```json
{
  "success": true,
  "message": "Doctor text medicine masters fetched successfully",
  "data": {
    "text_medicines": [
      {
        "id": 1,
        "medicine_value": "Alfa Compound Syrup",
        "is_active": 1,
        "created_at": "2026-05-21T10:00:00.000Z",
        "updated_at": "2026-05-21T10:00:00.000Z",
        "medical_products": [
          {
            "id": 25,
            "medicine_text_id": 1,
            "source_type": "RADIENT_PHARMA",
            "product_name": "Alfa Compound Syrup",
            "size_or_weight": "110ml",
            "mrp_rate": "105.00",
            "category": "SYRUPS",
            "is_active": 1,
            "created_at": "2026-05-21T10:00:00.000Z",
            "updated_at": "2026-05-21T10:00:00.000Z"
          }
        ],
        "products": [
          {
            "id": 10,
            "medicine_text_id": 1,
            "product_name": "Alfa Compound Syrup",
            "packing": "100 ML",
            "mrp_rate": "115.00",
            "product_type": "SYRUP",
            "is_active": 1,
            "created_at": "2026-05-21T10:00:00.000Z",
            "updated_at": "2026-05-21T10:00:00.000Z"
          }
        ],
        "radient_pharma_products": [
          {
            "id": 25,
            "medicine_text_id": 1,
            "product_name": "Alfa Compound Syrup",
            "net_weight_or_size": "110ml",
            "mrp_rate": "105.00",
            "shipper_size_pcs": 72,
            "category": "SYRUPS",
            "description": "Weight Gainer and Body Builder for all age",
            "formula_composition": "Alfalfa Q, Ashwagandha Q",
            "is_active": 1,
            "created_at": "2026-05-21T10:00:00.000Z",
            "updated_at": "2026-05-21T10:00:00.000Z"
          }
        ],
        "handwritten_product_prices": [
          {
            "id": 43,
            "medicine_text_id": 1,
            "category": "WSI",
            "product_name": "Alpha Liv",
            "price_text": "150",
            "price_min": "150.00",
            "price_max": "150.00",
            "is_active": 1,
            "created_at": "2026-05-21T10:00:00.000Z",
            "updated_at": "2026-05-21T10:00:00.000Z"
          }
        ]
      }
    ],
    "text_medicine_remarks": [
      {
        "id": 1,
        "remark_value": "Take after meals",
        "is_active": 1,
        "created_at": "2026-05-21T10:00:00.000Z",
        "updated_at": "2026-05-21T10:00:00.000Z"
      }
    ]
  },
  "meta": {
    "total_text_medicines": 1,
    "total_text_medicine_remarks": 1,
    "total_medical_products": 3,
    "total_products": 1,
    "total_radient_pharma_products": 1,
    "total_handwritten_product_prices": 1
  }
}
```

### Postman me kaise hit karein

1. Method `GET`
2. URL:
   - `http://localhost:3000/api/v1/doctors/masters/text-medicines`
3. `Authorization` → `Bearer Token`
4. Doctor token paste karein
5. Send karein

---

## 3) Get Single Appointment Detail

Selected patient ka detailed appointment record nikalne ke liye.

> Ye detail API ab receptionist approval/payment ke bina bhi appointment detail return kar sakti hai.
> Lekin consultation create/start karte waqt approval/payment checks alag endpoint par ab bhi lagenge.

### Endpoint

```http
GET /api/v1/doctors/appointments/:appointment_id
```

### Example

```http
GET /api/v1/doctors/appointments/12
```

### Postman me kaise hit karein

1. Method `GET`
2. URL:
   - `http://localhost:3000/api/v1/doctors/appointments/12`
3. `Authorization` → `Bearer Token`
4. Doctor token paste karein
5. Send karein

### Success Response Example

```json
{
  "success": true,
  "message": "Appointment detail fetched successfully",
  "data": {
    "appointment_id": 12,
    "auid": "AUID060520260001",
    "branch_name": "Main Branch",
    "treatment_name": "Migraine Treatment",
    "slot_name": "Morning Slot",
    "token_number": 4,
    "appointment_date": "2026-05-10",
    "status": "Pending",
    "patient_full_name": "Rahul Sahu",
    "patient_mobile_no": "9876543210",
    "consultation": null
  }
}
```

> Agar consultation already created hai, to `consultation` object response me aayega.

---

## 3A) Get Consultation History With Full Details

Doctor completed consultation history dekh sakta hai, aur har row me:
- complete appointment data
- complete patient data
- complete consultation data
- medicines + dosage details

### Endpoint

```http
GET /api/v1/doctors/consultations-history
```

### Query Params (optional)

- `branch_id` → positive integer
- `from_date` → `YYYY-MM-DD`
- `to_date` → `YYYY-MM-DD`
- `patient_search` → patient name / mobile / uuid

### Example

```http
GET /api/v1/doctors/consultations-history?from_date=2026-05-01&to_date=2026-05-31
```

### Postman me kaise hit karein

1. Method `GET`
2. URL:
   - `http://localhost:3000/api/v1/doctors/consultations-history`
3. `Authorization` → `Bearer Token`
4. Optional params add karein
5. Send karein

### Response me kya milega

Har item me:
- `appointment`
- `consultation`

Aur consultation object me:
- doctor info
- symptoms
- advice
- duration
- medications
- dosage details

---

## 4) Create Consultation

Doctor consultation save karega with symptoms, advice, duration, multiple medicines aur dosage.

### Endpoint

```http
POST /api/v1/doctors/consultations
```

### Rules

- `appointment_id` positive integer hona chahiye
- `medication_duration_days` sirf `7`, `15`, `30`
- `medications` array required hai
- `medicine_type` sirf `NUMERIC` ya `TEXT`
- Agar `medicine_type = NUMERIC` hai to `medicine_value` range `3` to `150`
- Har medication me:
  - `dosage.times_per_day`
  - `dosage.balls_per_dose`
  required hai
- Same appointment par dubara consultation create nahi ho sakta

### Request Body Example

```json
{
  "appointment_id": 12,
  "symptoms": "Fever, headache",
  "treatment_advice": "Avoid cold drinks",
  "medication_duration_days": 15,
  "medications": [
    {
      "medicine_type": "NUMERIC",
      "medicine_value": 30,
      "dosage": {
        "times_per_day": 2,
        "balls_per_dose": 4,
        "instructions": "Before meal"
      }
    },
    {
      "medicine_type": "TEXT",
      "medicine_value": "Belladonna",
      "dosage": {
        "times_per_day": 3,
        "balls_per_dose": 3,
        "instructions": "After meal"
      }
    }
  ]
}
```

### Postman me kaise hit karein

1. Method `POST`
2. URL:
   - `http://localhost:3000/api/v1/doctors/consultations`
3. `Authorization` → `Bearer Token`
4. Doctor token paste karein
5. `Body` → `raw` → `JSON`
6. Upar wala JSON paste karein
7. Send karein

### Success Response Example

```json
{
  "success": true,
  "message": "Consultation created successfully",
  "data": {
    "appointment": {
      "appointment_id": 12,
      "status": "Completed"
    },
    "consultation": {
      "consultation_id": 3,
      "appointment_id": 12,
      "doctor_id": 7,
      "medication_duration_days": 15,
      "symptoms": "Fever, headache",
      "treatment_advice": "Avoid cold drinks",
      "medications": [
        {
          "consultation_medication_id": 10,
          "medicine_type": "NUMERIC",
          "medicine_value": "30",
          "dosage": {
            "times_per_day": 2,
            "balls_per_dose": 4,
            "instructions": "Before meal"
          }
        }
      ]
    }
  }
}
```

---

## 5) Get Consultation by Appointment ID

Saved consultation record dekhne ke liye.

### Endpoint

```http
GET /api/v1/doctors/consultations/:appointment_id
```

### Example

```http
GET /api/v1/doctors/consultations/12
```

### Postman me kaise hit karein

1. Method `GET`
2. URL:
   - `http://localhost:3000/api/v1/doctors/consultations/12`
3. `Authorization` → `Bearer Token`
4. Doctor token paste karein
5. Send karein

### Success Response Example

```json
{
  "success": true,
  "message": "Consultation fetched successfully",
  "data": {
    "appointment": {
      "appointment_id": 12,
      "patient_full_name": "Rahul Sahu",
      "status": "Completed"
    },
    "consultation": {
      "consultation_id": 3,
      "appointment_id": 12,
      "doctor_name": "Dr. Amit",
      "medication_duration_days": 15,
      "symptoms": "Fever, headache",
      "treatment_advice": "Avoid cold drinks",
      "medications": [
        {
          "consultation_medication_id": 10,
          "medicine_type": "NUMERIC",
          "medicine_value": "30",
          "dosage": {
            "medication_dosage_id": 10,
            "times_per_day": 2,
            "balls_per_dose": 4,
            "instructions": "Before meal"
          }
        },
        {
          "consultation_medication_id": 11,
          "medicine_type": "TEXT",
          "medicine_value": "Belladonna",
          "dosage": {
            "medication_dosage_id": 11,
            "times_per_day": 3,
            "balls_per_dose": 3,
            "instructions": "After meal"
          }
        }
      ]
    }
  }
}
```

---

## Common Error Cases

### 401 Unauthorized

Jab token missing ya invalid ho:

```json
{
  "success": false,
  "message": "Invalid or expired token"
}
```

### 403 Forbidden

Jab non-doctor user doctor API hit kare:

```json
{
  "success": false,
  "message": "You are not authorized to access this resource"
}
```

### 400 Bad Request

Validation fail hone par:

- `appointment_id must be a positive integer`
- `appointment_date must be in YYYY-MM-DD format`
- `status must be one of Pending, Confirmed, Completed or Cancelled`
- `medication_duration_days must be one of 7, 15 or 30`
- `medications[0].medicine_value must be between 3 and 150 for NUMERIC type`

### 404 Not Found

- appointment nahi mila
- consultation nahi mili

### 409 Conflict

- consultation already exists for this appointment
- cancelled/inactive appointment par consultation create karne ki koshish

---

## Recommended Postman Collection Flow

Best testing order:

1. `POST /api/v1/auth/login`
2. `GET /api/v1/doctors/dashboard`
3. `GET /api/v1/doctors/patient`
4. `GET /api/v1/doctors/reports`
5. `GET /api/v1/doctors/appointments`
6. `GET /api/v1/doctors/appointments/:appointment_id`
7. `GET /api/v1/doctors/consultations-history`
8. `POST /api/v1/doctors/consultations`
9. `GET /api/v1/doctors/consultations/:appointment_id`

## Postman Environment Variables

Postman me ye variables banana useful rahega:

- `base_url` = `http://localhost:3000/api/v1`
- `doctor_token` = login response ka token
- `appointment_id` = selected appointment id

### Example URLs with variables

```text
{{base_url}}/auth/login
{{base_url}}/doctors/dashboard
{{base_url}}/doctors/patient
{{base_url}}/doctors/reports
{{base_url}}/doctors/appointments
{{base_url}}/doctors/appointments/{{appointment_id}}
{{base_url}}/doctors/consultations-history
{{base_url}}/doctors/consultations
{{base_url}}/doctors/consultations/{{appointment_id}}
```

### Authorization Header with variable

```text
Authorization: Bearer {{doctor_token}}
```

## Quick Summary

- Doctor token mandatory hai
- Total implemented doctor APIs: **8**
- Consultation module use karne ke liye migration run karna zaroori hai
- Postman testing ke liye pehle login, phir appointments, phir consultation flow follow karein
