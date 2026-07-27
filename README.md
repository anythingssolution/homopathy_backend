# Homopathy Clinic Backend (Auth API)

RESTful authentication API built with Node.js, Express, JWT, and MySQL using `mysql2/promise` with connection pooling.

> API namespace is versioned: active auth APIs are in `routes/v1` and exposed under `/api/v1/auth`.

## Features

- Patient registration (`POST /api/v1/auth/register`)
- Patient password login (`POST /api/v1/auth/login`)
- Patient password login alias (`POST /api/v1/auth/login/password`)
- Patient OTP request (`POST /api/v1/auth/login/otp/request`)
- Patient OTP verify/login (`POST /api/v1/auth/login/otp/verify`)
- Refresh access token (`POST /api/v1/auth/token/refresh`)
- Logout current session (`POST /api/v1/auth/logout`)
- Forgot password OTP request (`POST /api/v1/auth/password/forgot/request`)
- Forgot password OTP verify (`POST /api/v1/auth/password/forgot/verify`)
- Reset password (`POST /api/v1/auth/password/forgot/reset`)
- Protected profile endpoint (`GET /api/v1/auth/me`)
- Protected profile update endpoint (`PUT /api/v1/auth/me`)
- Appointment form data API (`GET /api/v1/appointments/form-data`)
- Appointment booking API (`POST /api/v1/appointments`)
- My appointments list API (`GET /api/v1/appointments/my`)
  - now includes `prescription` details when a consultation/prescription exists for that appointment
- Patient family members / dependents APIs (`GET/POST/PATCH /api/v1/family-members`)
- Appointment booking now supports `booking_for = SELF | FAMILY_MEMBER`
- Consultation bills auto-create at appointment booking time
- Receptionist appointment approval now includes consultation payment collection (`cash` / `online`)
- Receptionist can book appointments for patients (`POST /api/v1/receptionist/book-appointment`)
- Receptionist appointments list API (`GET /api/v1/receptionist/appointments`)
- Billing APIs (`GET /api/v1/bills`, `GET /api/v1/bills/:bill_id`, `POST /api/v1/bills/consultation`, `PATCH /api/v1/bills/consultation/:bill_id/collect-payment`, `POST /api/v1/bills/medication`)
- Receptionist mark not available API (`POST /api/v1/receptionist/appointments/:appointment_id/not-available`)
- Receptionist reschedule appointment API (`POST /api/v1/receptionist/appointments/:appointment_id/reschedule`)
- Real-time prescription workflow notifications via Socket.IO for doctor/receptionist/medical
- Notifications APIs (`GET /api/v1/notifications`, `PATCH /api/v1/notifications/:notification_id/read`, `PATCH /api/v1/notifications/read-all`)
- Medical prescription queue APIs (`GET /api/v1/medical/prescriptions`)
- Doctor appointments list API with patient details (`GET /api/v1/doctors/appointments`)
- Doctor branch-wise leave calendar APIs
  - `GET /api/v1/doctors/leaves`
  - `POST /api/v1/doctors/leaves`
  - `POST /api/v1/doctors/leaves/bulk`
  - `DELETE /api/v1/doctors/leaves/:leave_id`
  - `POST /api/v1/doctors/leaves/bulk-cancel`
- Public doctor booking availability API (`GET /api/v1/public/doctor-booking-availability`)
- Staff branch-selection flow for `doctor` / `receptionist` / `medical`
  - `GET /api/v1/auth/branches`
  - `PUT /api/v1/auth/selected-branch`
  - selected branch is auto-applied as backend filter across doctor/receptionist/medical module APIs
- JWT auth middleware
- Role-aware authorization middleware (`patient`, `doctor`, `receptionist`, `medical`)
- Access-token revocation on logout using `tbl_user_access_token_blacklist`
- Startup environment validation for JWT/DB/rate-limit configuration
- CORS support via `CORS_ORIGIN`
- Route-level rate limiting for login, OTP, forgot-password, and token refresh APIs
- Transaction-safe appointment creation with conflict checks
- Same-day slot bookings are blocked during the last 30 minutes before that slot's end time
- Appointment booking block rule:
  - active leave present ho to booking blocked
  - leave cancel ho chuki ho to booking allowed
  - doctor live session `OUT` hone ke bawajood booking allowed hai
- Live queue token convention: use `current_token_number` as the primary active token across modules; `original_token_number` is for audit/history
- Display token convention: backend response me `token_display` / `current_token_display` / `original_token_display` bhi aayega. Morning slots ke tokens `M-<number>` aur evening slots ke tokens `E-<number>` format me expose honge. Numeric token fields unchanged rahenge.
- One patient can have only one active appointment per date, regardless of slot or branch
- A primary patient account can manage up to 5 active family members/dependents without creating separate logins or duplicate mobile numbers
- Raw SQL queries (no ORM)
- MySQL pooled connection using `mysql2/promise`
- Global error handling + date-wise file logs in `logs/`
- Language preference support via `master_languages` and `log_user_logins`

## Setup

1. Copy environment file:
   - Copy `.env.example` to `.env`
2. Update DB, JWT, CORS, and rate-limit values in `.env`
3. Run SQL schema from:
   - `sql/master_tables.sql`
   - `sql/paitent_tables.sql`
4. If your database already exists, also run:
   - `sql/2026-05-03_security_roles_appointments.sql`
   - `sql/2026-05-06_doctor_consultations.sql`
   - `sql/2026-05-06_prescription_workflow_notifications.sql`
   - `sql/2026-05-08_medical_prescription_pricing.sql`
   - `sql/2026-05-08_reception_approval_flow.sql`
   - `sql/2026-05-12_billing_consultation_payment.sql`
   - `sql/2026-05-20_cross_module_access.sql`
   - `sql/2026-05-20_family_member_booking.sql`
   - `sql/2026-05-21_staff_selected_branch_scope.sql`
   - `sql/2026-05-22_staff_branch_access_notifications.sql`
   - `sql/2026-05-23_branch_doctor_leaves.sql`
5. Install dependencies and start server:

```bash
npm install
npm run dev
```

## API Endpoints

### Health

- `GET /api/health`
- `GET /api/v1/health`

### Family Members

- `GET /api/v1/family-members`
- `POST /api/v1/family-members`
- `PATCH /api/v1/family-members/:family_member_id`

Purpose:

- primary patient account apne dependents/family members manage kar sakta hai
- max 5 active members allowed hain
- same mobile/login reuse hota hai

### Appointment booking for self vs family member

`POST /api/v1/appointments` ab optional fields support karta hai:

```json
{
  "booking_for": "SELF"
}
```

ya

```json
{
  "booking_for": "FAMILY_MEMBER",
  "fk_patient_family_member_id": 12
}
```

Notes:

- `fk_patient_id` owner account hi rahega
- visiting patient detail response me `patient_full_name` / `visiting_patient_*` fields se milegi
- account holder detail `primary_patient_*` fields me milegi
- existing self-booking flow unchanged rahega

### Register

- `POST /api/v1/auth/register/otp/request`
- Body:

```json
{
  "mobile_no": "9876543210"
}
```

Notes:

- This endpoint sends a registration OTP to the provided mobile number.
- It returns an `otp_session_token` that must be used in the next step.
- User account is not created until the registration is completed.
- Registration OTP now uses the same DB-backed OTP table as login OTPs.

### Verify Registration OTP

- `POST /api/v1/auth/register/otp/verify`
- Body:

```json
{
  "mobile_no": "9876543210",
  "otp": "123456",
  "otp_session_token": "<token-from-previous-step>"
}
```

Notes:

- Verify the mobile number before submitting registration details.
- On success, the backend returns a temporary `registration_token`.
- Use the `registration_token` to complete the final registration.
- Invalid attempts are counted in DB and the OTP is marked used after successful verification.

### Complete Registration

- `POST /api/v1/auth/register`
- Body:

```json
{
  "full_name": "Rahul Sahu",
  "age": 29,
  "gender": "male",
  "email": "rahul@example.com",
  "mobile_no": "9876543210",
  "password": "secret123",
  "registration_token": "<token-from-otp-verify>"
}
```

Notes:

- Register success response returns `token` and `refresh_token`.
- Registered patient `uuid` is generated in the format `PAT<DDMMYYYY><4-digit-serial>`, for example `PAT040520260001`.

### Login

- `POST /api/v1/auth/login`
- `POST /api/v1/auth/login/password`
- Body:

```json
{
  "mobile_no": "9876543210",
  "password": "secret123"
}
```

Notes:

- Success response includes `token` and `refresh_token`.
- Password login is rate-limited.

### Refresh Access Token

- `POST /api/v1/auth/token/refresh`
- Body:

```json
{
  "refresh_token": "<refresh-token>"
}
```

Notes:

- This is a dedicated refresh-token API for all users.
- Send `refresh_token` and the API returns a new `token` plus a rotated `refresh_token`.
- The previously used refresh token is revoked after successful rotation.

### Logout (Protected)

- `POST /api/v1/auth/logout`

### Staff branch selection (`doctor` / `receptionist` / `medical`)

- `GET /api/v1/auth/branches`
- `PUT /api/v1/auth/selected-branch`
- `PATCH /api/v1/auth/selected-branch`

Request body:

```json
{
  "branch_id": 2
}
```

Notes:

- Only `doctor`, `receptionist`, and `medical` roles use this flow.
- Login / refresh / `GET /api/v1/auth/me` responses now include `branch_scope`.
- Available branches now come from `tbl_user_branch_access`, not from all active branches globally.
- If one of these roles has no selected branch, protected staff APIs return `409` with `branch_selection_required: true`.
- Once branch is selected, backend automatically applies that branch to doctor/receptionist/medical APIs unless the same branch is explicitly passed.
- Sending another branch id than the selected one returns `403`.
- Staff notifications are now stored with `branch_id` and fetched/marked-read only within the currently selected branch.

See also:

- [Staff branch selection frontend handoff](./README_STAFF_BRANCH_SELECTION_FRONTEND.md)
- Header:
  - `Authorization: Bearer <ACCESS_TOKEN>`

Notes:

- Logout now revokes the current access token server-side.
- Logout also revokes the user's active refresh-token sessions.
- After logout, the same token can no longer access protected routes.
- Client should still remove the token from local storage/session storage.

### Login via OTP (Step 1: Request OTP)

- `POST /api/v1/auth/login/otp/request`
- Body:

```json
{
  "mobile_no": "9876543210"
}
```

Notes:

- OTP resend is blocked for 60 seconds.
- In local/non-production, response includes `default_otp` for testing.
- In production, dynamic OTP is generated and stored hashed in DB.
- Login OTP request is rate-limited.
- Successful OTP login response includes `token` and `refresh_token`.

### Login via OTP (Step 2: Verify OTP)

- `POST /api/v1/auth/login/otp/verify`
- Body:

```json
{
  "mobile_no": "9876543210",
  "otp": "123456"
}
```

Notes:

- Invalid OTP attempts are capped.
- OTP verify is rate-limited.

### Forgot Password (Step 1: Request OTP)

- `POST /api/v1/auth/password/forgot/request`
- Body:

```json
{
  "mobile_no": "9876543210"
}
```

### Forgot Password (Step 2: Verify OTP)

- `POST /api/v1/auth/password/forgot/verify`
- Body:

```json
{
  "mobile_no": "9876543210",
  "otp": "123456",
  "otp_session_token": "<token-from-step-1>"
}
```

Notes:

- Successful verify response returns a temporary `reset_token`.
- Forgot-password OTP also uses the DB-backed OTP table with resend cooldown and attempt tracking.

### Forgot Password (Step 3: Reset Password)

- `POST /api/v1/auth/password/forgot/reset`
- Body:

```json
{
  "mobile_no": "9876543210",
  "new_password": "newSecret123",
  "reset_token": "<token-from-step-2>"
}
```

### Current Patient (Protected)

- `GET /api/v1/auth/me`
- Header:
- `Authorization: Bearer <JWT_TOKEN>`

Notes:

- After `POST /api/v1/auth/logout`, the same token is revoked and can no longer access this endpoint.

### Update Current Patient Profile (Protected)

- `PUT /api/v1/auth/me`
- Header:
  - `Authorization: Bearer <JWT_TOKEN>`
- Body (send only fields to update):

```json
{
  "full_name": "Rahul Sahu Updated",
  "age": 30,
  "gender": "male",
  "description": "Updated treatment notes",
  "mobile_no": "9876543211"
}
```

## Appointment APIs (Protected)

> These APIs require `Authorization: Bearer <TOKEN>` header.
> Current patient-facing appointment routes are restricted to the `patient` role.
> Appointment cancellation route supports `patient`, `doctor`, `receptionist`, and `medical` roles, with patient ownership checks.

### 1) Get Appointment Form Data

- `GET /api/v1/appointments/form-data`
- Optional query param:
  - `branch_id` (to fetch only slots of one branch)

Sample URL:

- `GET /api/v1/appointments/form-data?branch_id=1`

Sample success response:

```json
{
  "success": true,
  "message": "Appointment form data fetched successfully",
  "data": {
    "branches": [
      {
        "id": 1,
        "branch_name": "Main Branch",
        "address": "City Center",
        "contact_no": 9876543210
      }
    ],
    "treatments": [
      {
        "id": 1,
        "treatment_name": "Migraine Consultation",
        "description": "Initial consultation",
        "estimated_duration_minutes": 30
      }
    ],
    "slots": [
      {
        "id": 2,
        "fk_branch_id": 1,
        "slot_name": "Morning Session",
        "start_time": "09:00:00",
        "end_time": "12:00:00"
      }
    ],
    "meta": {
      "statuses": ["Pending", "Confirmed", "Completed", "Cancelled"],
      "token_number_range": {
        "min": 1,
        "max": 40
      }
    }
  }
}
```

### 2) Create Appointment

- `POST /api/v1/appointments`
- Content-Type: `application/json`
- Body (Postman JSON):

```json
{
  "fk_branch_id": 1,
  "fk_treatment_id": 2,
  "fk_slot_id": 3,
  "appointment_date": "2026-05-10",
  "token_number": 5,
  "symptoms": "Headache and acidity from last 2 days"
}
```

Notes:

- Required fields: `fk_branch_id`, `fk_treatment_id`, `fk_slot_id`, `appointment_date`
- `appointment_date` format must be `YYYY-MM-DD` and should not be in the past.
- `token_number` is optional, but if sent it must be between 1 and 40.
- If `token_number` is omitted, the backend auto-assigns the next available token between 1 and 40.
- Successful booking also creates an appointment public ID in format `AUID<DDMMYYYY><4-digit-serial>`, for example `AUID040520260001`.
- Selected slot must belong to the selected branch.
- Same patient same date par multiple appointments tab tak allowed nahi hain jab tak koi unresolved active appointment (`Pending` ya `Confirmed`) exist karta ho.
- Agar same date ka previous appointment `Completed` ya `Cancelled` ho chuka hai, to naya appointment create kiya ja sakta hai.
- `token_number` must be unique inside the same `branch + slot + date`.
- Booking is created inside a DB transaction to reduce race-condition issues during concurrent booking.

Sample success response:

```json
{
  "success": true,
  "message": "Appointment created successfully",
  "data": {
    "appointment_id": 12,
    "auid": "AUID100520260001",
    "fk_patient_id": 5,
    "fk_branch_id": 1,
    "branch_name": "Main Branch",
    "fk_treatment_id": 2,
    "treatment_name": "General Consultation",
    "fk_slot_id": 3,
    "slot_name": "Evening Session",
    "start_time": "17:00:00",
    "end_time": "20:00:00",
    "token_number": 5,
    "appointment_date": "2026-05-10",
    "symptoms": "Headache and acidity from last 2 days",
    "status": "Pending",
    "cancelled_at": null,
    "cancelled_by_user_id": null,
    "cancelled_by_role": null,
    "cancel_reason": null,
    "is_active": 1,
    "created_at": "2026-05-01T09:00:00.000Z",
    "updated_at": "2026-05-01T09:00:00.000Z"
  }
}
```

### 3) List My Appointments

- `GET /api/v1/appointments/my`
- Response note:
  - if any appointment has doctor consultation/prescription data, the same appointment object now includes a `prescription` field with:
    - consultation details
    - doctor info
    - medicines
    - dosage details

### Receptionist APIs

- `POST /api/v1/receptionist/book-appointment`
- `GET /api/v1/receptionist/appointments`
- `POST /api/v1/receptionist/appointments/:appointment_id/approve-and-collect-payment`
- `POST /api/v1/receptionist/appointments/:appointment_id/approve` *(legacy alias; ab payment payload mandatory hai)*
- `POST /api/v1/receptionist/appointments/:appointment_id/not-available`
- `POST /api/v1/receptionist/appointments/:appointment_id/reschedule`
- `GET /api/v1/receptionist/prescriptions`
- `GET /api/v1/receptionist/prescriptions/:consultation_id`

> Receptionist prescription APIs are now read-only. Doctor finalization ke baad prescription direct Medical queue me chala jata hai.

### Medical APIs

- `GET /api/v1/medical/prescriptions`
- `GET /api/v1/medical/prescriptions/:consultation_id`
- `POST /api/v1/medical/prescriptions/:consultation_id/pricing`
- `POST /api/v1/medical/prescriptions/:consultation_id/process`
- `POST /api/v1/bills/medication`

### Billing APIs

- `POST /api/v1/bills/consultation`
- `PATCH /api/v1/bills/consultation/:bill_id/collect-payment`
- `GET /api/v1/bills`
- `GET /api/v1/bills/:bill_id`

> Detailed billing flow, reasons, and payload examples: `README_BILLING_MODULE.md`
> Receptionist approval + payment payload pattern: `README_RECEPTIONIST_MODULE.md`

> `GET /api/v1/medical/prescriptions` now returns patient details + appointment details + prescription details in list form.
> `POST /api/v1/medical/prescriptions/:consultation_id/pricing` saves total prescription amount plus row-wise medicine pricing.

### Notifications APIs

- `GET /api/v1/notifications`
- `PATCH /api/v1/notifications/:notification_id/read`
- `PATCH /api/v1/notifications/read-all`

Notes:

- For `doctor` / `receptionist` / `medical`, notification APIs are selected-branch scoped.
- Notification records now carry `branch_id` where applicable, so unread counts and history stay branch-specific for staff users.

Sample success response:

```json
{
  "success": true,
  "message": "Appointments fetched successfully",
  "data": [
    {
      "appointment_id": 12,
      "auid": "AUID100520260001",
      "fk_patient_id": 5,
      "fk_branch_id": 1,
      "branch_name": "Main Branch",
      "fk_treatment_id": 2,
      "treatment_name": "General Consultation",
      "fk_slot_id": 3,
      "slot_name": "Evening Session",
      "start_time": "17:00:00",
      "end_time": "20:00:00",
      "token_number": 5,
      "appointment_date": "2026-05-10",
      "symptoms": "Headache and acidity from last 2 days",
      "status": "Pending",
      "cancelled_at": null,
      "cancelled_by_user_id": null,
      "cancelled_by_role": null,
      "cancel_reason": null,
      "is_active": 1,
      "created_at": "2026-05-01T09:00:00.000Z",
      "updated_at": "2026-05-01T09:00:00.000Z"
    }
  ]
}
```

### 4) Cancel Appointment

- `PATCH /api/v1/appointments/:appointment_id/cancel`
- Content-Type: `application/json`
- Body:

```json
{
  "cancel_reason": "Patient is not available on selected date"
}
```

Notes:

- `patient` can cancel only their own appointment.
- `doctor`, `receptionist`, and `medical` roles can also cancel appointments.
- Already cancelled or completed appointments cannot be cancelled again.
- Cancellation stores `cancelled_at`, `cancelled_by_user_id`, `cancelled_by_role`, and `cancel_reason`.
- Cancelled appointments are marked inactive so the slot/token can be rebooked later.

### 5) Doctor: List Appointments with Patient Details

- `GET /api/v1/doctors/appointments`
- Role access: `doctor` only
- Optional query params:
  - `branch_id` (positive integer)
  - `appointment_date` (`YYYY-MM-DD`)
  - `status` (`Pending`, `Confirmed`, `Completed`, `Cancelled`)
  - `patient_search` (matches patient full name, mobile, or uuid)

Sample URL:

- `GET /api/v1/doctors/appointments?appointment_date=2026-05-10&status=Pending&patient_search=rahul`

Notes:

- Each appointment row includes patient profile fields (without password).
- Doctor ko ab upcoming appointments reception approval/payment se independent tarike se dikhengi.
- Consultation start/create karne ke liye approval/payment wali backend restrictions alag se apply hoti rahengi.
- This endpoint is protected with JWT auth + role-based authorization middleware.

## Notes

- Ensure `master_users` table exists before calling auth APIs. The users table includes a `role` column and new registrations are stored with role `patient`.
- Supported normalized roles are: `patient`, `doctor`, `receptionist`, `medical`.
- DB-based role verification: `master_users.role` stores a role **code** (`PAT`, `DOC`, `REC`, `MED`) and middleware verifies it against `master_roles` on every authenticated request.
- Existing legacy role values such as role names and `medical_staff` / `MEDS` are normalized to `MED` during migration and in middleware.
- Ensure `master_languages`, `log_user_logins`, `tbl_user_otps`, and `tbl_appointments` are created from `paitent_tables.sql`.
- `tbl_user_otps.purpose` now supports `register`, `login`, and `forgot_password`.
- `tbl_appointments` now stores public appointment IDs in `auid` format and cancellation audit fields.
- Ensure `master_clinic_branches`, `master_treatments`, and `master_slots` are created from `master_tables.sql`.
- If you already have an older database, run `sql/2026-05-03_security_roles_appointments.sql` before using the new authorization and appointment conflict rules.
- `JWT_SECRET` is mandatory and must be a strong random value in production; server startup now fails if it is missing or weak.
- `JWT_REFRESH_EXPIRES_IN` controls refresh token expiry and defaults to `7d`.
- Prefer setting `FORGOT_PASSWORD_TOKEN_SECRET` separately in production.
- Set `CORS_ORIGIN` to your frontend origin in production instead of `*`.
- Auth and OTP routes are rate-limited using environment-based limits.
- Refresh-token sessions are stored in `tbl_user_refresh_tokens`.
- In production, keep `.env` out of version control.
- Daily error logs are stored in `logs/error-YYYY-MM-DD.log`.
- Compatibility route is also enabled: `/api/auth/*` currently maps to `v1`.
