# Medical Module README

This document explains the **Medical module APIs**, their purpose, expected request format, response shape, and **how to hit them from Postman step by step**.

---

## 1) Base Details

### Base URL
Use your local/project base URL, for example:

```text
http://localhost:3000/api/v1
```

Adjust the host/port according to your environment.

### Role required
All Medical module APIs require:

- authenticated user
- user role = `medical`
- ya doctor-granted medical module access

Family-member booking ke baad medical APIs me patient-facing name field:

- `patient_full_name`

ab visiting patient / dependent ko represent karega.

Additional helpful fields:

- `primary_patient_full_name`
- `booked_for_type`
- `family_member_relationship`

---

## 2) Medical Module API List

### 1. Get medical prescription queue

```http
GET /api/v1/medical/prescriptions
```

Returns all prescriptions that are ready for the medical team.

Current backend logic returns only:

- `workflow_status = READY_FOR_MEDICAL`

This API includes:

- patient details
- appointment details
- doctor details
- prescription details
- medicines with row-wise doses
- pricing if already saved

Optional query:

- `pricing_status=all|priced|unpriced`

---

### 1A. Get priced medical prescriptions list

```http
GET /api/v1/medical/prescriptions/priced
```

Returns only those prescriptions jinke pricing/amount already save ho chuke hain.

This API includes:

- patient details
- appointment details
- prescription details
- pricing details

---

### 2. Get single medical prescription detail

```http
GET /api/v1/medical/prescriptions/:consultation_id
```

Returns complete details of one prescription by consultation id.

Includes:

- consultation info
- patient info
- doctor info
- branch info
- treatment info
- medicines
- row-wise doses
- saved pricing

---

### 3. Save prescription pricing

```http
POST /api/v1/medical/prescriptions/:consultation_id/pricing
```

Use this API when the medical team wants to save:

- total prescription amount
- optional remark
- medicine-wise amount

This supports row-wise medicine pricing.

---

### 4. Process prescription

```http
POST /api/v1/medical/prescriptions/:consultation_id/process
```

Use this when the medical team has completed/processed the prescription.

Current backend behavior:

- allowed only when consultation workflow is `READY_FOR_MEDICAL`
- changes workflow to `PROCESSED_BY_MEDICAL`
- sends notifications to receptionist and doctor

### 5. Create medication bill

```http
POST /api/v1/bills/medication
```

### Why this new API?

Medical pricing table alag concern hai, lekin patient/doctor/medical billing visibility ke liye separate bill record chahiye. Isliye medication pricing finalize hone ke baad medication bill create karne ke liye dedicated billing API add ki gayi hai.

Request body example:

```json
{
  "consultation_id": 5,
  "remark": "Medication bill generated from saved pricing"
}
```

### Postman me kaise hit karein

1. Method `POST`
2. URL:
   - `http://localhost:3000/api/v1/bills/medication`
3. `Authorization` → `Bearer Token`
4. Medical token paste karein
5. `Body` → `raw` → `JSON`
6. Upar wala JSON paste karein
7. Send karein

---

## 3) Workflow Summary

High-level flow:

1. Doctor creates/finalizes prescription
2. Prescription direct `READY_FOR_MEDICAL` ban jati hai
3. `sent_to_medical_at` doctor finalize step me hi set hota hai
4. Medical team ko direct notification / socket event milta hai
5. Medical team sees it in:
   - `GET /api/v1/medical/prescriptions`
6. Receptionist sirf read-only list/detail dekh sakta hai
7. Medical team saves pricing
   - pricing table me row create/update hoti hai
   - response me `pricing_status = PRICED` aur `is_priced = true` milta hai
8. Medical team processes prescription

---

## 4) Detailed API Documentation

---

## API 1: Get medical prescription queue

### Endpoint

```http
GET /api/v1/medical/prescriptions
```

### Headers

```http
Authorization: Bearer <MEDICAL_ACCESS_TOKEN>
Content-Type: application/json
```

### Sample success response

```json
{
  "success": true,
  "message": "Medical prescriptions fetched successfully",
  "data": [
    {
      "consultation_id": 5,
      "appointment_id": 20,
      "workflow_status": "READY_FOR_MEDICAL",
      "sent_to_medical_at": "2026-05-08T10:00:00.000Z",
      "pricing_status": "PRICED",
      "is_priced": true,
      "appointment": {
        "appointment_id": 20,
        "auid": "APT-00020",
        "appointment_date": "2026-05-08",
        "token_number": 7,
        "original_token_number": 7,
        "current_token_number": 7,
        "status": "Completed",
        "branch_name": "Main Branch",
        "treatment_name": "General Consultation",
        "slot_name": "Morning Slot",
        "start_time": "09:00:00",
        "end_time": "12:00:00"
      },
      "patient": {
        "patient_uuid": "PAT-1001",
        "full_name": "Rahul Sahu",
        "mobile_no": "9876543210",
        "email": "rahul@example.com",
        "age": 30,
        "gender": "Male",
        "description": ""
      },
      "doctor": {
        "doctor_id": 12,
        "doctor_name": "Dr. Amit"
      },
      "prescription": {
        "medication_duration_days": 30,
        "symptoms": "Clinical Findings",
        "treatment_advice": "Treatment Advice",
        "created_at": "2026-05-08T09:45:00.000Z",
        "updated_at": "2026-05-08T09:45:00.000Z",
        "medications": [
          {
            "consultation_medication_id": 11,
            "medicine_type": "NUMERIC",
            "medicine_value": "14",
            "remark": null,
            "doses": [
              {
                "medication_dosage_id": 1,
                "dose_label": "MORNING",
                "sort_order": 1,
                "times_per_day": 1,
                "balls_per_dose": 5,
                "instructions": ""
              }
            ]
          },
          {
            "consultation_medication_id": 12,
            "medicine_type": "TEXT",
            "medicine_value": "syrup1",
            "remark": "test syrup1",
            "doses": []
          }
        ],
        "pricing": {
          "pricing_id": 2,
          "consultation_id": 5,
          "total_amount": 123,
          "remark": "",
          "created_by": 44,
          "updated_by": 44,
          "created_at": "2026-05-08T11:00:00.000Z",
          "updated_at": "2026-05-08T11:00:00.000Z",
          "medications": [
            {
              "pricing_item_id": 1,
              "consultation_medication_id": 12,
              "medicine_value": "syrup1",
              "amount": 123,
              "created_at": "2026-05-08T11:00:00.000Z",
              "updated_at": "2026-05-08T11:00:00.000Z"
            }
          ]
        }
      }
    }
  ],
  "meta": {
    "total": 1
  }
}
```

---

## API 2: Get single medical prescription detail

### Endpoint

```http
GET /api/v1/medical/prescriptions/:consultation_id
```

### Example

```http
GET /api/v1/medical/prescriptions/5
```

### Headers

```http
Authorization: Bearer <MEDICAL_ACCESS_TOKEN>
Content-Type: application/json
```

### Validation

- `consultation_id` must be a positive integer

### Common errors

#### Invalid consultation id

```json
{
  "success": false,
  "message": "Valid consultation_id is required"
}
```

#### Not found

```json
{
  "success": false,
  "message": "Prescription not found"
}
```

---

## API 3: Save prescription pricing

### Endpoint

```http
POST /api/v1/medical/prescriptions/:consultation_id/pricing
```

### Example

```http
POST /api/v1/medical/prescriptions/5/pricing
```

### Headers

```http
Authorization: Bearer <MEDICAL_ACCESS_TOKEN>
Content-Type: application/json
```

### Request body

```json
{
  "consultation_id": 5,
  "amount": 123,
  "remark": "",
  "medications": [
    {
      "consultation_medication_id": 12,
      "medicine_value": "syrup1",
      "amount": 123
    },
    {
      "consultation_medication_id": 13,
      "medicine_value": "syrup2",
      "amount": 50
    }
  ]
}
```

### Notes

- `consultation_id` can be supplied in:
  - route param
  - body
- total `amount` is the full prescription amount
- each medication item should include:
  - `medicine_value`
  - `amount`
- `consultation_medication_id` is recommended when available

### Validation rules

- `consultation_id` must be valid
- `amount` must be a non-negative number
- `medications` array is required
- every medication must have:
  - `medicine_value`
  - `amount`

### Success response

Returns updated prescription detail including pricing.

```json
{
  "success": true,
  "message": "Medical prescription pricing saved successfully",
  "data": {
    "consultation_id": 5,
    "appointment_id": 20,
    "workflow_status": "READY_FOR_MEDICAL",
    "pricing": {
      "pricing_id": 2,
      "consultation_id": 5,
      "total_amount": 173,
      "remark": "",
      "medications": [
        {
          "pricing_item_id": 1,
          "consultation_medication_id": 12,
          "medicine_value": "syrup1",
          "amount": 123
        },
        {
          "pricing_item_id": 2,
          "consultation_medication_id": 13,
          "medicine_value": "syrup2",
          "amount": 50
        }
      ]
    }
  }
}
```

### Error examples

#### Missing medications

```json
{
  "success": false,
  "message": "medications array is required"
}
```

#### Invalid total amount

```json
{
  "success": false,
  "message": "amount must be a valid non-negative number"
}
```

---

## API 4: Process prescription

### Endpoint

```http
POST /api/v1/medical/prescriptions/:consultation_id/process
```

### Example

```http
POST /api/v1/medical/prescriptions/5/process
```

### Headers

```http
Authorization: Bearer <MEDICAL_ACCESS_TOKEN>
Content-Type: application/json
```

### Behavior

- checks prescription exists
- only allows `READY_FOR_MEDICAL`
- marks it `PROCESSED_BY_MEDICAL`
- sends live notifications to:
  - receptionist
  - doctor

### Conflict example

```json
{
  "success": false,
  "message": "Only medical-ready prescriptions can be processed"
}
```

---

## 5) Postman Setup Step by Step

This section explains exactly how to test these APIs in Postman.

---

## Step 1: Create Postman environment

Create a new Postman environment, for example:

- **Environment name:** `Homopathy Clinic Local`

Add these variables:

| Variable | Example Value |
|---|---|
| `base_url` | `http://localhost:3000/api/v1` |
| `medical_token` | `<paste-token-here>` |
| `consultation_id` | `5` |

---

## Step 2: Login as medical user

Use your existing login/auth API that returns access token for a medical user.

Example if your project has a common login API:

```http
POST {{base_url}}/auth/login
```

Sample body:

```json
{
  "email": "medical@example.com",
  "password": "123456"
}
```

After success:

1. copy access token
2. save token in Postman environment variable:
   - `medical_token`

---

## Step 3: Set common headers

For all medical APIs use:

### Header 1
- Key: `Authorization`
- Value:

```text
Bearer {{medical_token}}
```

### Header 2
- Key: `Content-Type`
- Value:

```text
application/json
```

---

## Step 4: Hit prescription queue API

### Request

```http
GET {{base_url}}/medical/prescriptions
```

Only priced:

```http
GET {{base_url}}/medical/prescriptions?pricing_status=priced
```

Only unpriced:

```http
GET {{base_url}}/medical/prescriptions?pricing_status=unpriced
```

Dedicated priced list:

```http
GET {{base_url}}/medical/prescriptions/priced
```

### What to check

- does list return?
- patient data aa raha hai?
- appointment data aa raha hai?
- medicines aa rahi hain?
- `pricing` null hai ya saved object?

### If list empty
Possible reasons:

- receptionist approval nahi hui
- consultation status `READY_FOR_MEDICAL` nahi hai
- no prescription has reached medical stage

---

## Step 5: Pick one `consultation_id`

Queue API response se koi ek `consultation_id` copy karo.

Usko Postman env var me set kar do:

- `consultation_id`

---

## Step 6: Hit single prescription detail API

### Request

```http
GET {{base_url}}/medical/prescriptions/{{consultation_id}}
```

### What to verify

- correct patient details
- doctor details
- medicine list
- row-wise doses
- `pricing` initially null ho sakti hai

---

## Step 7: Save pricing

### Request

```http
POST {{base_url}}/medical/prescriptions/{{consultation_id}}/pricing
```

### Body

```json
{
  "consultation_id": {{consultation_id}},
  "amount": 173,
  "remark": "All medicines packed",
  "medications": [
    {
      "consultation_medication_id": 12,
      "medicine_value": "syrup1",
      "amount": 123
    },
    {
      "consultation_medication_id": 13,
      "medicine_value": "syrup2",
      "amount": 50
    }
  ]
}
```

### What to verify

- success message
- `pricing.total_amount`
- `pricing.remark`
- every medicine item amount

### Re-save behavior

If same consultation par pricing dubara save karoge:

- old pricing header update hoga
- old items replace honge
- latest values store hongi

---

## Step 8: Verify pricing in detail API

Again hit:

```http
GET {{base_url}}/medical/prescriptions/{{consultation_id}}
```

Ab `pricing` object populated milna chahiye.

Ab priced list bhi test kar sakte ho:

```http
GET {{base_url}}/medical/prescriptions/priced
```

---

## Step 9: Process prescription

### Request

```http
POST {{base_url}}/medical/prescriptions/{{consultation_id}}/process
```

### What to verify

- response success
- workflow becomes `PROCESSED_BY_MEDICAL`
- medical processed timestamp aaye
- doctor/receptionist notifications trigger ho

---

## Step 10: Re-check queue API

Again hit:

```http
GET {{base_url}}/medical/prescriptions
```

Since queue only returns `READY_FOR_MEDICAL`,
processed item ideally queue se bahar ho jana chahiye.

---

## 6) Recommended Postman Testing Order

Best order:

1. login as medical
2. `GET /medical/prescriptions`
3. `GET /medical/prescriptions/:consultation_id`
4. `POST /medical/prescriptions/:consultation_id/pricing`
5. `GET /medical/prescriptions/:consultation_id`
6. `POST /medical/prescriptions/:consultation_id/process`
7. `GET /medical/prescriptions`

---

## 7) Common Debug Tips

### 1. 401 Unauthorized
Check:

- token valid hai?
- Authorization header सही hai?
- `Bearer <token>` format use hua?

### 2. 403 Forbidden
Check:

- logged-in user role `medical` hai ya nahi

### 3. Prescription list empty
Check:

- receptionist approval hui?
- workflow `READY_FOR_MEDICAL` hai?

### 4. Pricing save error
Check:

- `amount` valid number hai?
- `medications` array bheji?
- `medicine_value` every item me diya?

### 5. Process error
Check:

- prescription already processed to nahi?
- workflow `READY_FOR_MEDICAL` hai?

---

## 8) Related Files

- [controllers/v1/medicalController.js](/opt/homebrew/var/www/vectre-office/backend_node_js/homopathy_clinic_backend_node_js/controllers/v1/medicalController.js)
- [routes/v1/medicalRoutes.js](/opt/homebrew/var/www/vectre-office/backend_node_js/homopathy_clinic_backend_node_js/routes/v1/medicalRoutes.js)
- [sql/2026-05-08_medical_prescription_pricing.sql](/opt/homebrew/var/www/vectre-office/backend_node_js/homopathy_clinic_backend_node_js/sql/2026-05-08_medical_prescription_pricing.sql)

---

## 9) Important Note

Before testing pricing API, make sure this migration has been run:

- [sql/2026-05-08_medical_prescription_pricing.sql](/opt/homebrew/var/www/vectre-office/backend_node_js/homopathy_clinic_backend_node_js/sql/2026-05-08_medical_prescription_pricing.sql)
