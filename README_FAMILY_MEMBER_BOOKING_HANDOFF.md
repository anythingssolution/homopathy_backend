# Family Member Booking Handoff

## What changed

Backend me ab **primary patient account + family members table + self/member booking model** add kiya gaya hai.

Iska matlab:

- login/mobile number sirf **primary patient account** ka rahega
- same account ke under **max 5 active family members** manage kiye ja sakte hain
- appointment `SELF` ya `FAMILY_MEMBER` ke liye book ho sakti hai
- existing modules ko break kiye bina `fk_patient_id` owner account hi rakha gaya hai

## Why this was needed

Current system me ek mobile number = ek patient account model tha.

Real clinic use-case me:

- parent apne child ke liye book karta hai
- husband wife ke liye book karta hai
- ek family same mobile number use karti hai

Agar har dependent ke liye `master_users` me separate same-mobile account banate:

- login conflict hota
- OTP conflict hota
- `/auth/me` ambiguous ho jata
- existing patient/mobile uniqueness break hoti

Isliye dependent records ko separate table me rakha gaya.

## Core model

### 1. Primary patient account

- `master_users`
- unique mobile number
- login/OTP/account owner

### 2. Family members / dependents

- new table: `tbl_patient_family_members`
- same login share nahi karte
- sirf owner account ke under stored hote hain

### 3. Appointment subject

Appointments me ab:

- `booked_for_type = SELF | FAMILY_MEMBER`
- `fk_patient_family_member_id`

Use hota hai.

## No-break design decisions

Ye feature existing flows ko break na kare isliye:

1. `fk_patient_id` ko **owner account** hi rakha gaya
2. billing ownership same rakha gaya
3. patient `/appointments/my` same account ke under sab appointments la sakta hai
4. cancellation ownership same account owner se hi chalegi
5. old self-booking payload bina kisi change ke ab bhi kaam karega

## New DB objects

### New table

- `tbl_patient_family_members`

Main fields:

- `fk_primary_patient_id`
- `full_name`
- `age`
- `gender`
- `relationship`
- `description`
- `is_active`

### Appointment changes

- `fk_patient_family_member_id`
- `booked_for_type`
- stored `booking_subject_key`

## Why `booking_subject_key` added

Pehle unique appointment guard sirf `fk_patient_id` par effectively depend karta tha.

Family booking ke baad ye galat hota, kyunki:

- same owner ke 2 alag dependents same date par book kar sakte hain

Isliye booking subject key use ki gayi:

- `SELF:<patient_id>`
- `FM:<family_member_id>`

Taaki DB level uniqueness subject-wise maintain rahe.

> Note: isse normal stored column rakha gaya hai, generated column nahi, taaki wider MySQL compatibility rahe.

## New APIs

### Family members

- `GET /api/v1/family-members`
- `POST /api/v1/family-members`
- `PATCH /api/v1/family-members/:family_member_id`

### Existing booking API extended

- `POST /api/v1/appointments`
- `POST /api/v1/receptionist/book-appointment`

New supported fields:

```json
{
  "booking_for": "FAMILY_MEMBER",
  "fk_patient_family_member_id": 4
}
```

Default remains:

```json
{
  "booking_for": "SELF"
}
```

## Response changes

Appointment-like payloads me ye fields mil sakte hain:

- `booked_for_type`
- `fk_patient_family_member_id`
- `family_member_relationship`
- `primary_patient_full_name`
- `primary_patient_mobile_no`
- `patient_full_name`
- `visiting_patient_full_name`
- `is_family_member_booking`

### Important meaning

- `patient_full_name` = visible visiting patient name
- `primary_patient_full_name` = account holder name

## Which modules were updated

### Patient

- appointment form-data
- self booking
- my appointments payload

### Receptionist

- patient detail now includes family members
- booking can target family member
- appointment list supports family-member display fields

### Doctor

- appointment list / dashboard / reports now receive visiting patient fields

### Medical

- prescription queue/detail now receive visiting patient fields

### Billing

- bill summary/detail/list now expose visiting patient info

### Live Queue

- queue snapshot and current-date token payload now expose family-member aware patient fields

## Frontend changes needed

### Patient side

1. Add **Family Members** management screen
2. In booking UI add:
   - `Book for Self`
   - `Book for Family Member`
3. If family member selected:
   - show dependent dropdown
4. My appointments UI should show:
   - visiting patient name
   - optional relationship badge
   - account holder name only as secondary info

### Receptionist side

1. Patient detail modal/page me family members section dikhani hogi
2. Reception booking form me:
   - `booking_for` toggle
   - family member selector for selected patient
3. Queue list row me main name visiting patient ka dikhna chahiye
4. Optional small subtitle:
   - `Booked under Rahul Sharma account`

### Doctor side

1. Doctor appointment list me main name visiting patient ka dikhna chahiye
2. Secondary small info:
   - `Primary: Rahul Sharma`
   - `Relation: Son`

### Medical side

1. Prescription list/detail me same visiting patient display use karna hoga
2. Labels billing/dispense screen par visiting patient ke naam se align karni hongi

### Billing UI

1. Bill list/detail me visible patient name visiting patient ka ho
2. Optional owner/account holder label secondary line me dikhayein

## FAQ

### Q1. Same mobile number multiple users me kyun nahi use kiya?

Because current auth model `master_users.mobile_no` unique hai aur login/OTP flow same-mobile multiple accounts ko safely support nahi karta.

### Q2. `fk_patient_id` owner account hi kyun rakha?

Taaki:

- auth ownership
- bills
- appointment history
- existing cancellation permissions

break na ho.

### Q3. `patient_full_name` kis ko represent karega?

Ab **visiting patient** ko.

### Q4. Primary patient name kaha milega?

- `primary_patient_full_name`

### Q5. Max 5 limit kyun?

Clinic use-case ke hisaab se enough hai aur uncontrolled dependent growth ko avoid karta hai.

### Q6. Kya old self-booking requests break hongi?

Nahi.

`booking_for` optional hai aur default `SELF` hai.

### Q7. Kya receptionist new patient create karke uske family member ke liye same request me booking kar sakti hai?

Abhi recommended flow:

1. primary patient create/search
2. family member add
3. uske baad family member booking

### Q8. Kya doctor/medical/reception responses me old fields hata diye gaye?

Nahi, intent ye rakha gaya hai ki old flows survive karein. New fields additive hain, aur visible patient name family-aware bana diya gaya hai.

## Recommended frontend rollout order

1. family member CRUD UI
2. patient booking toggle
3. receptionist dependent selector
4. appointment card/list display updates
5. doctor + medical + billing label cleanup

## Files changed in backend for this feature

- `controllers/v1/appointmentController.js`
- `controllers/v1/receptionistController.js`
- `controllers/v1/doctorController.js`
- `controllers/v1/medicalController.js`
- `controllers/v1/billController.js`
- `services/billingService.js`
- `services/liveQueueService.js`
- `controllers/v1/familyMemberController.js`
- `routes/v1/familyMemberRoutes.js`
- `routes/v1/index.js`
- `utils/patientFamily.js`
- `sql/2026-05-20_family_member_booking.sql`

## Final summary

Ye implementation:

- same mobile / same login preserve karti hai
- dependents allow karti hai
- existing modules ko owner-account model ke through safe rakhti hai
- frontend ko clearer patient-vs-owner display pattern provide karti hai
