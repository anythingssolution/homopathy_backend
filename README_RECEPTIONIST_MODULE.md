# Receptionist Module README

Ye document receptionist module ke sabhi APIs, request/response JSON examples, token handling, approval/payment flow, reschedule flow, aur receptionist-side read-only prescription visibility ko explain karta hai.

## Base URL

```text
http://localhost:3000/api/v1/receptionist
```

## Auth / Role Access

Har API ke liye:

```text
Authorization: Bearer <RECEPTIONIST_ACCESS_TOKEN>
```

Required role:

- `receptionist`
- ya doctor-granted reception module access

## Required SQL Migrations

- `sql/2026-05-06_receptionist_booking_token_shift.sql`
- `sql/2026-05-06_prescription_workflow_notifications.sql`
- `sql/2026-05-08_reception_approval_flow.sql`
- `sql/2026-05-12_billing_consultation_payment.sql`
- `sql/2026-05-14_live_queue_realtime.sql`
- `sql/2026-05-19_live_queue_dynamic_positions.sql`
- `sql/2026-05-20_cross_module_access.sql`
- `sql/2026-05-20_family_member_booking.sql`

## Receptionist Scope

Receptionist:

- patient ke behalf par appointment book kar sakti hai
- patient ke active family member / dependent ke behalf par bhi appointment book kar sakti hai
- form-data / patient search dekh sakti hai
- appointments list filters ke saath dekh sakti hai
- self-booked ya pending appointments ko approve karke payment collect kar sakti hai
- appointment reject kar sakti hai
- patient ko not-available mark karke token last me bhej sakti hai
- appointment reschedule kar sakti hai
- doctor-finalized prescriptions ko read-only mode me dekh sakti hai
- live queue / LED display ke liye realtime queue ko indirectly drive karti hai

## Token Convention

Live queue ke liye always:

- `current_token_number`

Supporting fields:

- `original_token_number` → audit/history
- `token_number` → compatibility alias
- `token_display` / `current_token_display` / `original_token_display` → UI-safe prefixed values. Morning slot ke liye `M-<number>`, evening slot ke liye `E-<number>`.
- `display_token_number` / `display_token_display` → patient-facing recommended fixed token fields
- `is_shifted` → token move hua ya nahi
- `shift_reason` → kis reason se move hua
- `not_available_at` → not-available timestamp
- `queue_status` → live queue runtime state
- `checked_in_at` → actual arrival/check-in timestamp
- `arrival_sequence` → check-in capture order
- `booked_for_type` → `SELF` / `FAMILY_MEMBER`
- `fk_patient_family_member_id` → dependent id when applicable
- `family_member_relationship` → dependent relationship
- `primary_patient_full_name` → account holder name
- `queue_bucket` → `READY` / `CALLED` / `NOT_ARRIVED` / `IN_PROGRESS`
- `live_queue_position` → live serving position
- `planned_start_at` / `planned_end_at` → planned queue timing
- `actual_called_at` / `actual_started_at` / `actual_completed_at` → realtime queue timestamps

Detailed live queue APIs and socket flow:

- `README_LIVE_QUEUE_REALTIME.md`

## What changed in backend and why

- receptionist-facing queue module ab fixed display token ko support karta hai
- runtime queue compatibility ke liye `current_token_number` abhi bhi retained hai
- patient token display ke liye frontend ko `display_token_display` use karna chahiye
- not-available / skip-style actions ke baad readiness fields reset hote hain, taaki patient later aake fresh check-in kar sake
- live queue mutation APIs ab protected hain; public board sirf read/listen karega
- family member booking add ki gayi hai bina patient login/mobile model ko tode

## Implemented APIs

1. `POST /api/v1/receptionist/book-appointment`
2. `GET /api/v1/receptionist/form-data`
3. `GET /api/v1/receptionist/appointments`
4. `POST /api/v1/receptionist/appointments/:appointment_id/approve-and-collect-payment`
5. `POST /api/v1/receptionist/appointments/:appointment_id/approve`
6. `POST /api/v1/receptionist/appointments/:appointment_id/reject`
7. `GET /api/v1/receptionist/patients`
8. `GET /api/v1/receptionist/patients/:patient_id`
9. `POST /api/v1/receptionist/appointments/:appointment_id/not-available`
10. `POST /api/v1/receptionist/appointments/:appointment_id/reschedule`
11. `GET /api/v1/receptionist/prescriptions`
12. `GET /api/v1/receptionist/prescriptions/:consultation_id`

---

## 1) Book Appointment by Receptionist

### Endpoint

```http
POST /api/v1/receptionist/book-appointment
```

### Purpose

Receptionist patient ke liye naya appointment create karti hai.

Ye booking:

- self
- family member / dependent

dono ke liye use ho sakti hai.

### Request JSON

```json
{
  "fk_patient_id": 12,
  "fk_branch_id": 1,
  "fk_treatment_id": 2,
  "fk_slot_id": 3,
  "appointment_date": "2026-05-20",
  "booking_for": "FAMILY_MEMBER",
  "fk_patient_family_member_id": 4,
  "symptoms": "Headache and acidity",
  "token_number": 5
}
```

### Request Notes

- `fk_patient_id`, `fk_branch_id`, `fk_treatment_id`, `fk_slot_id`, `appointment_date` required
- `appointment_date` format: `YYYY-MM-DD`
- `booking_for` optional hai, default `SELF`
- `booking_for = FAMILY_MEMBER` ho to `fk_patient_family_member_id` required hai
- `token_number` optional hai
- `token_number` diya ho to `1..40` range me hona chahiye
- agar `token_number` na do to backend next free token assign karega
- same patient ke same date par doosra **unresolved active** appointment (`Pending` ya `Confirmed`) allow nahi hai
- agar same date ka previous appointment `Completed` ya `Cancelled` hai to naya appointment create kiya ja sakta hai
- slot selected branch ka hona chahiye
- same queue me duplicate token allow nahi hai
- family member booking tabhi allow hogi jab selected patient account ke under valid active dependent exist kare
- receptionist booking par backend:
  - `booked_by_type = RECEPTIONIST`
  - `booked_by_user_id = current receptionist`
  - `reception_status = PENDING_AT_RECEPTION`

### Success Response JSON

```json
{
  "success": true,
  "message": "Appointment booked by receptionist successfully",
  "data": {
    "appointment_id": 101,
    "auid": "AUID130520260001",
    "fk_patient_id": 12,
    "fk_branch_id": 1,
    "branch_name": "Main Branch",
    "fk_treatment_id": 2,
    "treatment_name": "Homeopathy Consultation",
    "fk_slot_id": 3,
    "slot_name": "Morning Slot",
    "start_time": "09:00:00",
    "end_time": "11:00:00",
    "token_number": 5,
    "original_token_number": 5,
    "current_token_number": 5,
    "is_shifted": 0,
    "shift_reason": null,
    "not_available_at": null,
    "booked_by_type": "RECEPTIONIST",
    "booked_by_user_id": 44,
    "rescheduled_from_appointment_id": null,
    "reschedule_reason": null,
    "appointment_date": "2026-05-20",
    "symptoms": "Headache and acidity",
    "status": "Pending",
    "reception_status": "APPROVED_BY_RECEPTION",
    "reception_approved_at": null,
    "reception_approved_by": null,
    "consultation_payment_status": "UNPAID",
    "consultation_bill_id": 501,
    "payment_collected_at": null,
    "payment_collected_by": null,
    "reception_rejected_at": null,
    "reception_rejected_by": null,
    "reception_rejection_reason": null,
    "cancelled_at": null,
    "cancelled_by_user_id": null,
    "cancelled_by_role": null,
    "cancel_reason": null,
    "is_active": 1,
    "created_at": "2026-05-13T10:30:00.000Z",
    "updated_at": "2026-05-13T10:30:00.000Z",
    "patient_id": 12,
    "patient_uuid": "PAT-00012",
    "patient_full_name": "Rahul Sharma",
    "patient_age": 28,
    "patient_gender": "Male",
    "patient_email": "rahul@example.com",
    "patient_mobile_no": "9876543210",
    "patient_description": "Frequent acidity"
  }
}
```

### Common Error JSON

```json
{
  "success": false,
  "message": "This patient already has an unresolved active appointment for the selected date"
}
```

---

## 2) Receptionist Form Data

### Endpoint

```http
GET /api/v1/receptionist/form-data
```

### Query Params

- `branch_id` optional positive integer

### Example

```http
GET /api/v1/receptionist/form-data?branch_id=1
```

### Success Response JSON

```json
{
  "success": true,
  "message": "Receptionist form data fetched successfully",
  "data": {
    "branches": [
      {
        "id": 1,
        "branch_name": "Main Branch",
        "address": "City Center",
        "contact_no": "9999999999"
      }
    ],
    "treatments": [
      {
        "id": 2,
        "treatment_name": "Homeopathy Consultation",
        "description": "General consultation",
        "estimated_duration_minutes": 30,
        "consultation_fee": "500.00"
      }
    ],
    "slots": [
      {
        "id": 3,
        "fk_branch_id": 1,
        "slot_name": "Morning Slot",
        "start_time": "09:00:00",
        "end_time": "11:00:00"
      }
    ],
    "meta": {
      "token_number_range": {
        "min": 1,
        "max": 40
      },
      "booking_sources": ["SELF", "RECEPTIONIST"],
      "statuses": ["Pending", "Confirmed", "Completed", "Cancelled"],
      "reception_statuses": [
        "PENDING_AT_RECEPTION",
        "APPROVED_BY_RECEPTION",
        "REJECTED_BY_RECEPTION"
      ]
    }
  }
}
```

---

## 3) Receptionist Appointments List

### Endpoint

```http
GET /api/v1/receptionist/appointments
```

### Query Params

- `branch_id`
- `slot_id`
- `appointment_date`
- `patient_search`
- `booked_by_type` → `SELF | RECEPTIONIST`
- `reception_status` → `PENDING_AT_RECEPTION | APPROVED_BY_RECEPTION | REJECTED_BY_RECEPTION`

### Example

```http
GET /api/v1/receptionist/appointments?appointment_date=2026-05-20&branch_id=1&reception_status=PENDING_AT_RECEPTION
```

### Success Response JSON

```json
{
  "success": true,
  "message": "Receptionist appointments fetched successfully",
  "data": [
    {
      "appointment_id": 101,
      "auid": "AUID130520260001",
      "fk_patient_id": 12,
      "fk_branch_id": 1,
      "branch_name": "Main Branch",
      "fk_treatment_id": 2,
      "treatment_name": "Homeopathy Consultation",
      "fk_slot_id": 3,
      "slot_name": "Morning Slot",
      "start_time": "09:00:00",
      "end_time": "11:00:00",
      "token_number": 5,
      "original_token_number": 5,
      "current_token_number": 5,
      "is_shifted": 0,
      "shift_reason": null,
      "not_available_at": null,
      "booked_by_type": "SELF",
      "booked_by_user_id": 12,
      "rescheduled_from_appointment_id": null,
      "reschedule_reason": null,
      "appointment_date": "2026-05-20",
      "symptoms": "Headache",
      "status": "Pending",
      "reception_status": "PENDING_AT_RECEPTION",
      "reception_approved_at": null,
      "reception_approved_by": null,
      "consultation_payment_status": "UNPAID",
      "consultation_bill_id": 501,
      "payment_collected_at": null,
      "payment_collected_by": null,
      "reception_rejected_at": null,
      "reception_rejected_by": null,
      "reception_rejection_reason": null,
      "cancelled_at": null,
      "cancelled_by_user_id": null,
      "cancelled_by_role": null,
      "cancel_reason": null,
      "is_active": 1,
      "created_at": "2026-05-13T10:30:00.000Z",
      "updated_at": "2026-05-13T10:30:00.000Z",
      "patient_id": 12,
      "patient_uuid": "PAT-00012",
      "patient_full_name": "Rahul Sharma",
      "patient_age": 28,
      "patient_gender": "Male",
      "patient_email": "rahul@example.com",
      "patient_mobile_no": "9876543210",
      "patient_description": "Frequent acidity"
    }
  ],
  "meta": {
    "filters": {
      "branch_id": 1,
      "slot_id": null,
      "appointment_date": "2026-05-20",
      "patient_search": null,
      "booked_by_type": null,
      "reception_status": "PENDING_AT_RECEPTION"
    },
    "total": 1
  }
}
```

---

## 4) Approve Appointment + Collect Consultation Payment

### Endpoints

```http
POST /api/v1/receptionist/appointments/:appointment_id/approve-and-collect-payment
POST /api/v1/receptionist/appointments/:appointment_id/approve
```

Second endpoint legacy alias hai, behavior same hai.

### Purpose

Receptionist appointment approve karti hai aur consultation bill payment collect karti hai.

### Request JSON (Cash)

```json
{
  "payment_mode": "CASH",
  "amount": 500,
  "transaction_reference": null,
  "remark": "Consultation fee collected at desk"
}
```

### Request JSON (Online)

```json
{
  "payment_mode": "ONLINE",
  "amount": 500,
  "transaction_reference": "UPI-REF-12345",
  "remark": "Paid by UPI"
}
```

### Validation

- `payment_mode` required
- `amount` valid non-negative number hona chahiye
- `ONLINE` me `transaction_reference` required
- active non-cancelled appointment hona chahiye
- full pending amount hi collect ho sakta hai

### Success Response JSON

```json
{
  "success": true,
  "message": "Appointment approved and consultation payment collected successfully",
  "data": {
    "appointment": {
      "appointment_id": 101,
      "reception_status": "APPROVED_BY_RECEPTION",
      "consultation_payment_status": "PAID",
      "consultation_bill_id": 501,
      "payment_collected_at": "2026-05-13T11:00:00.000Z",
      "payment_collected_by": 44
    },
    "bill": {
      "bill_id": 501,
      "appointment_id": 101,
      "bill_type": "CONSULTATION",
      "bill_status": "PAID",
      "total_amount": "500.00",
      "paid_amount": "500.00",
      "pending_amount": "0.00",
      "payments": [
        {
          "payment_mode": "CASH",
          "amount": "500.00",
          "transaction_reference": null,
          "remark": "Consultation fee collected at desk"
        }
      ]
    }
  }
}
```

### Already Approved Case

```json
{
  "success": true,
  "message": "Consultation payment collected successfully for approved appointment",
  "data": {
    "appointment": {
      "appointment_id": 101,
      "reception_status": "APPROVED_BY_RECEPTION",
      "consultation_payment_status": "PAID"
    },
    "bill": {
      "bill_id": 501,
      "bill_status": "PAID"
    }
  }
}
```

---

## 5) Reject Appointment

### Endpoint

```http
POST /api/v1/receptionist/appointments/:appointment_id/reject
```

### Request JSON

```json
{
  "reason": "Patient details incomplete"
}
```

### Request Notes

- `reason` optional hai
- default reason: `"Rejected by receptionist"`

### Success Response JSON

```json
{
  "success": true,
  "message": "Appointment rejected by receptionist successfully",
  "data": {
    "appointment_id": 101,
    "reception_status": "REJECTED_BY_RECEPTION",
    "reception_rejected_at": "2026-05-13T11:15:00.000Z",
    "reception_rejected_by": 44,
    "reception_rejection_reason": "Patient details incomplete",
    "reception_approved_at": null,
    "reception_approved_by": null
  }
}
```

---

## 6) Receptionist Patients List

### Endpoint

```http
GET /api/v1/receptionist/patients
```

### Query Params

- `search` → name / mobile / uuid / email

### Example

```http
GET /api/v1/receptionist/patients?search=rahul
```

### Success Response JSON

```json
{
  "success": true,
  "message": "Receptionist patients fetched successfully",
  "data": [
    {
      "patient_id": 12,
      "patient_uuid": "PAT-00012",
      "full_name": "Rahul Sharma",
      "age": 28,
      "gender": "Male",
      "email": "rahul@example.com",
      "mobile_no": "9876543210",
      "description": "Frequent acidity",
      "created_at": "2026-05-01T08:00:00.000Z",
      "updated_at": "2026-05-10T08:00:00.000Z",
      "total_appointments": 4,
      "last_appointment_date": "2026-05-20"
    }
  ],
  "meta": {
    "search": "rahul",
    "total": 1
  }
}
```

---

## 7) Receptionist Patient Detail

### Endpoint

```http
GET /api/v1/receptionist/patients/:patient_id
```

### Example

```http
GET /api/v1/receptionist/patients/12
```

### Success Response JSON

```json
{
  "success": true,
  "message": "Receptionist patient detail fetched successfully",
  "data": {
    "patient": {
      "patient_id": 12,
      "patient_uuid": "PAT-00012",
      "full_name": "Rahul Sharma",
      "age": 28,
      "gender": "Male",
      "email": "rahul@example.com",
      "mobile_no": "9876543210",
      "description": "Frequent acidity",
      "is_active": 1,
      "created_at": "2026-05-01T08:00:00.000Z",
      "updated_at": "2026-05-10T08:00:00.000Z"
    },
    "summary": {
      "total_appointments": 4,
      "completed_appointments": 1,
      "active_appointments": 2,
      "last_appointment_date": "2026-05-20"
    },
    "recent_appointments": [
      {
        "appointment_id": 101,
        "auid": "AUID130520260001",
        "fk_branch_id": 1,
        "branch_name": "Main Branch",
        "fk_treatment_id": 2,
        "treatment_name": "Homeopathy Consultation",
        "fk_slot_id": 3,
        "slot_name": "Morning Slot",
        "start_time": "09:00:00",
        "end_time": "11:00:00",
        "token_number": 5,
        "original_token_number": 5,
        "current_token_number": 5,
        "appointment_date": "2026-05-20",
        "booked_by_type": "SELF",
        "status": "Pending",
        "is_active": 1,
        "created_at": "2026-05-13T10:30:00.000Z"
      }
    ],
    "recent_consultations": [
      {
        "consultation_id": 301,
        "appointment_id": 77,
        "workflow_status": "READY_FOR_MEDICAL",
        "medication_duration_days": 15,
        "created_at": "2026-05-11T09:00:00.000Z",
        "updated_at": "2026-05-11T09:30:00.000Z",
        "doctor_name": "Dr. Mehta"
      }
    ]
  }
}
```

---

## 8) Mark Appointment Not Available

### Endpoint

```http
POST /api/v1/receptionist/appointments/:appointment_id/not-available
```

### Request JSON

```json
{
  "reason": "Patient not available at clinic"
}
```

### Request Notes

- `reason` optional hai
- default reason: `NOT_AVAILABLE`

### Logic

1. appointment active honi chahiye
2. completed/cancelled appointment par allow nahi
3. selected token ko same queue ke last token `40` par move kiya jata hai
4. beech ke appointments ek token upar shift hote hain

### Success Response JSON

```json
{
  "success": true,
  "message": "Appointment marked not available and moved to last token successfully",
  "data": {
    "appointment_id": 101,
    "token_number": 40,
    "original_token_number": 5,
    "current_token_number": 40,
    "is_shifted": 1,
    "shift_reason": "Patient not available at clinic",
    "not_available_at": "2026-05-13T12:00:00.000Z",
    "status": "Pending"
  }
}
```

---

## 9) Reschedule Appointment

### Endpoint

```http
POST /api/v1/receptionist/appointments/:appointment_id/reschedule
```

### Request JSON

```json
{
  "fk_branch_id": 1,
  "fk_treatment_id": 2,
  "fk_slot_id": 4,
  "appointment_date": "2026-05-22",
  "symptoms": "Follow-up visit",
  "token_number": 3,
  "reason": "Patient requested new time"
}
```

### Request Notes

- `fk_branch_id`, `fk_treatment_id`, `fk_slot_id`, `appointment_date` required
- target old appointment jaisa same branch + slot + date nahi ho sakta
- active non-cancelled appointment hi reschedule ho sakti hai
- same patient ke same new date par another active appointment allow nahi

### Logic

1. old appointment validate hoti hai
2. old queue compact hoti hai
3. old appointment inactive/cancelled mark hoti hai
4. new appointment fresh create hoti hai
5. `rescheduled_from_appointment_id` aur `reschedule_reason` save hota hai
6. agar old consultation bill already tha to woh new appointment se transfer hota hai

### Success Response JSON

```json
{
  "success": true,
  "message": "Appointment rescheduled successfully",
  "data": {
    "appointment_id": 202,
    "auid": "AUID130520260002",
    "fk_patient_id": 12,
    "fk_branch_id": 1,
    "fk_treatment_id": 2,
    "fk_slot_id": 4,
    "appointment_date": "2026-05-22",
    "token_number": 3,
    "original_token_number": 3,
    "current_token_number": 3,
    "booked_by_type": "RECEPTIONIST",
    "rescheduled_from_appointment_id": 101,
    "reschedule_reason": "Patient requested new time",
    "status": "Pending",
    "reception_status": "APPROVED_BY_RECEPTION",
    "consultation_payment_status": "UNPAID",
    "consultation_bill_id": 501,
    "is_active": 1
  }
}
```

---

## 10) Receptionist Prescription Queue

### Endpoint

```http
GET /api/v1/receptionist/prescriptions
```

### Query Params

- `workflow_status` optional

Allowed:

- `READY_FOR_MEDICAL`
- `PROCESSED_BY_MEDICAL`

### Example

```http
GET /api/v1/receptionist/prescriptions?workflow_status=READY_FOR_MEDICAL
```

### Success Response JSON

```json
{
  "success": true,
  "message": "Receptionist prescriptions fetched successfully",
  "data": [
    {
      "consultation_id": 301,
      "appointment_id": 77,
      "workflow_status": "READY_FOR_MEDICAL",
      "doctor_finalized_at": "2026-05-13T13:00:00.000Z",
      "sent_to_medical_at": "2026-05-13T13:00:00.000Z",
      "medical_processed_at": null,
      "created_at": "2026-05-13T12:30:00.000Z",
      "token_number": 6,
      "original_token_number": 6,
      "current_token_number": 6,
      "patient_full_name": "Rahul Sharma",
      "patient_mobile_no": "9876543210",
      "doctor_name": "Dr. Mehta",
      "appointment_date": "2026-05-13",
      "branch_name": "Main Branch",
      "treatment_name": "Homeopathy Consultation"
    }
  ],
  "meta": {
    "filters": {
      "workflow_status": "READY_FOR_MEDICAL"
    },
    "total": 1,
    "summary": {
      "ready_for_medical": 1,
      "processed_by_medical": 0
    },
    "read_only": true
  }
}
```

---

## 11) Receptionist Prescription Detail

### Endpoint

```http
GET /api/v1/receptionist/prescriptions/:consultation_id
```

### Example

```http
GET /api/v1/receptionist/prescriptions/301
```

### Success Response JSON

```json
{
  "success": true,
  "message": "Receptionist prescription detail fetched successfully",
  "data": {
    "consultation_id": 301,
    "appointment_id": 77,
    "doctor_id": 9,
    "doctor_uuid": "DOC-00009",
    "doctor_name": "Dr. Mehta",
    "symptoms": "Headache with acidity",
    "treatment_advice": "Avoid spicy food",
    "medication_duration_days": 15,
    "workflow_status": "READY_FOR_MEDICAL",
    "doctor_finalized_at": "2026-05-13T13:00:00.000Z",
    "reception_notified_at": null,
    "reception_approved_at": null,
    "reception_approved_by": null,
    "reception_rejected_at": null,
    "reception_rejected_by": null,
    "reception_rejection_reason": null,
    "sent_to_medical_at": "2026-05-13T13:00:00.000Z",
    "medical_processed_at": null,
    "medical_processed_by": null,
    "created_at": "2026-05-13T12:30:00.000Z",
    "updated_at": "2026-05-13T13:00:00.000Z",
    "auid": "AUID130520260003",
    "appointment_date": "2026-05-13",
    "token_number": 6,
    "original_token_number": 6,
    "current_token_number": 6,
    "appointment_status": "Pending",
    "patient_id": 12,
    "patient_uuid": "PAT-00012",
    "patient_full_name": "Rahul Sharma",
    "patient_mobile_no": "9876543210",
    "patient_email": "rahul@example.com",
    "patient_age": 28,
    "patient_gender": "Male",
    "branch_id": 1,
    "branch_name": "Main Branch",
    "treatment_id": 2,
    "treatment_name": "Homeopathy Consultation",
    "slot_id": 3,
    "slot_name": "Morning Slot",
    "medications": [
      {
        "consultation_medication_id": 901,
        "medicine_type": "NUMERIC",
        "medicine_value": "30",
        "remark": null,
        "doses": [
          {
            "medication_dosage_id": 1001,
            "dose_label": "DOSE_1",
            "sort_order": 1,
            "times_per_day": 3,
            "balls_per_dose": 4,
            "instructions": "Before meal"
          }
        ]
      }
    ]
  }
}
```

---

## Prescription Workflow Note

Receptionist prescription approve/reject nahi karti.

Current flow:

1. doctor consultation finalize karta hai
2. consultation direct `READY_FOR_MEDICAL` me jati hai
3. `sent_to_medical_at` fill hota hai
4. medical role ko notification milta hai
5. receptionist sirf read-only list/detail/counts dekhti hai

## Booking Source Tracking

Appointment table me booking source fields:

- `booked_by_type`
  - `SELF`
  - `RECEPTIONIST`
- `booked_by_user_id`

## Status Notes

Appointment side:

- `status` → `Pending | Confirmed | Completed | Cancelled`
- `reception_status` → `PENDING_AT_RECEPTION | APPROVED_BY_RECEPTION | REJECTED_BY_RECEPTION`
- `consultation_payment_status` → generally `UNPAID | PAID`

## Recommended Postman Order

1. receptionist login
2. `GET /receptionist/form-data`
3. `GET /receptionist/patients?search=...`
4. `POST /receptionist/book-appointment`
5. `GET /receptionist/appointments`
6. `POST /receptionist/appointments/:appointment_id/approve-and-collect-payment`
7. `POST /receptionist/appointments/:appointment_id/reject`
8. `POST /receptionist/appointments/:appointment_id/not-available`
9. `POST /receptionist/appointments/:appointment_id/reschedule`
10. `GET /receptionist/prescriptions`
11. `GET /receptionist/prescriptions/:consultation_id`

## Related Files

- `controllers/v1/receptionistController.js`
- `routes/v1/receptionistRoutes.js`
- `services/billingService.js`
- `sql/2026-05-06_receptionist_booking_token_shift.sql`
- `sql/2026-05-06_prescription_workflow_notifications.sql`
- `sql/2026-05-08_reception_approval_flow.sql`
- `sql/2026-05-12_billing_consultation_payment.sql`
