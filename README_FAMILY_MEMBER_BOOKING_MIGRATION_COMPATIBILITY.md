# Family Member Booking Migration Compatibility README

## Purpose

Ye document explain karta hai ki family-member booking feature ko migration-safe aur backward-compatible kaise banaya gaya hai.

## Problem

Jab backend code family-member booking support ke saath deploy ho gaya, lekin DB migration abhi run nahi hui thi, tab errors aa sakte the jaise:

```json
{
  "error": "Unknown column 'a.booked_for_type' in 'where clause'"
}
```

## Root Cause

Backend new fields expect kar raha tha:

- `tbl_patient_family_members`
- `tbl_appointments.booked_for_type`
- `tbl_appointments.fk_patient_family_member_id`
- `tbl_appointments.booking_subject_key`

Lekin DB me ye schema abhi present nahi tha.

## Fix Applied

Backend me schema-awareness add ki gayi hai.

### New behavior

Backend pehle check karta hai ki family-member booking schema available hai ya nahi.

If schema available:

- self booking works
- family-member booking works

If schema not available:

- self booking old compatible flow se continue karegi
- family-member booking raw SQL error dene ke bajaye meaningful error degi

## Affected endpoint behavior

### `GET /api/v1/appointments/form-data`

If migration not run:

- still works
- `family_members = []`
- `family_member_booking_enabled = false`

If migration run:

- family members list return karega
- `family_member_booking_enabled = true`

### `POST /api/v1/appointments`

If migration not run:

- `booking_for = SELF` works
- `booking_for = FAMILY_MEMBER` blocked with clean message

If migration run:

- both self and family-member booking work

### `GET /api/v1/appointments/my`

- old self-booking path break nahi hoga
- schema ho to family-aware payload fields bhi aayenge

### `PATCH /api/v1/appointments/:appointment_id/cancel`

- owner-account cancellation flow backward compatible rahega

## Why this is important

Ye compatibility layer isliye zaroori thi taaki:

1. backend deploy ke baad app turant break na ho
2. migration delayed ho to bhi self-booking chale
3. rollout phased way me ho sake

## Backend strategy used

### 1. Runtime schema detection

Backend information_schema check karta hai:

- dependent table exist karti hai ya nahi
- required appointment columns exist karte hain ya nahi

### 2. Dual query path

Schema available ho to:

- new family-member aware queries use hoti hain

Schema available na ho to:

- legacy queries use hoti hain

### 3. Safe feature gating

Family-member specific booking tabhi allow hogi jab migration fully applied ho.

## Frontend expectation

Frontend ko ye flag use karna chahiye:

- `family_member_booking_enabled`

### If false

- family-member UI hide/disable karo

### If true

- self/family-member booking selector dikhao
- family member dropdown dikhao

## Recommended rollout order

1. backend deploy
2. migration run
3. frontend family-member UI enable

## FAQ

### Q1. Agar migration run nahi hui to kya self booking band ho jayegi?

Nahi.

### Q2. Agar migration run nahi hui to family-member booking chalegi?

Nahi. Clean validation-style message milega.

### Q3. Kya raw SQL unknown-column error ab aani chahiye?

Nahi, normal self-booking flow me nahi.

### Q4. Frontend ko kaunsa flag dekhna chahiye?

- `family_member_booking_enabled`

## Related files

- [appointmentController.js](/opt/homebrew/var/www/vectre-office/backend_node_js/homopathy_clinic_backend_node_js/controllers/v1/appointmentController.js)
- [patientFamily.js](/opt/homebrew/var/www/vectre-office/backend_node_js/homopathy_clinic_backend_node_js/utils/patientFamily.js)
- [2026-05-20_family_member_booking.sql](/opt/homebrew/var/www/vectre-office/backend_node_js/homopathy_clinic_backend_node_js/sql/2026-05-20_family_member_booking.sql)
- [README_FAMILY_MEMBER_BOOKING_HANDOFF.md](/opt/homebrew/var/www/vectre-office/backend_node_js/homopathy_clinic_backend_node_js/README_FAMILY_MEMBER_BOOKING_HANDOFF.md)
