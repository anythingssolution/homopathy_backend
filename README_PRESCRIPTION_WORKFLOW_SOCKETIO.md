# Prescription Workflow + Socket.IO README

Ye document updated **doctor → medical direct** prescription workflow aur uske real-time Socket.IO integration ko explain karta hai. Receptionist ab is flow me **read-only observer** hai.

## Goal

Jab doctor prescription finalize kare:

1. medical ko instantly pata chale
2. receptionist consulted/processed list aur counts dekh sake
3. medical process kare
4. doctor / receptionist / medical ke beech live sync bana rahe

---

# High-Level Workflow

## Step 1: Doctor creates/finalizes prescription

Doctor consultation create karta hai.

Current implementation me consultation create hote hi:

- workflow status becomes:
  - `READY_FOR_MEDICAL`
- timestamps update:
  - `doctor_finalized_at`
  - `sent_to_medical_at`

Then system:
- notification rows create karta hai medical users ke liye
- Socket.IO event emit karta hai:
  - `prescription.ready_for_medical`

---

## Step 2: Receptionist views prescription queue (read-only)

Receptionist:

- `GET /api/v1/receptionist/prescriptions` se consulted prescriptions dekh sakta hai
- `READY_FOR_MEDICAL` vs `PROCESSED_BY_MEDICAL` counts dekh sakta hai
- `GET /api/v1/receptionist/prescriptions/:consultation_id` se detail dekh sakta hai

Receptionist approve/reject nahi karta.

---

## Step 3: Medical processes prescription

Medical user direct doctor-finalized prescriptions dekhta hai.

When processed:

- workflow becomes:
  - `PROCESSED_BY_MEDICAL`

System:

- doctor ko notify karta hai
- receptionist ko notify karta hai
- Socket.IO event:
  - `prescription.processed`

---

# Workflow Status Values

`tbl_consultations.workflow_status` values currently used by active flow:

- `DRAFT`
- `READY_FOR_MEDICAL`
- `PROCESSED_BY_MEDICAL`

Legacy/reserved values schema me ho sakti hain, but active flow me receptionist approval step use nahi hota.

---

# Database Fields Used

## `tbl_consultations`

- `workflow_status`
- `doctor_finalized_at`
- `sent_to_medical_at`
- `medical_processed_at`
- `medical_processed_by`

Legacy audit columns jaise `reception_notified_at`, `reception_approved_at`, `reception_rejected_at` schema me reh sakte hain, but new active flow me required nahi hain.

## `tbl_notifications`

- `user_id`
- `role_code`
- `type`
- `title`
- `message`
- `entity_type`
- `entity_id`
- `is_read`
- `created_at`
- `read_at`

---

# Why Notification Table + Socket.IO both?

## Socket.IO

Real-time live update ke liye

## Notification table

Persistent history ke liye

Kyuki agar medical ya receptionist uss samay online na ho:

- event miss ho sakta hai
- but DB notification later fetch ki ja sakti hai

---

# Socket.IO Implementation

## Package

- `socket.io`

## Server Integration

Socket.IO server `server.js` me attach hai.

Internally:

- HTTP server created
- Socket.IO attached
- JWT auth verify hota hai
- socket rooms auto assign hoti hain

---

# Socket Rooms

Connected user automatically join karta hai:

- `user:<userId>`
- `role:<role_code>`

Example:

- Doctor → `role:DOC`
- Receptionist → `role:REC`
- Medical → `role:MED`

---

# Socket Events

## Emitted on connect

- `socket.connected`

## Workflow events

### Doctor → Medical
- `prescription.ready_for_medical`

### Medical → Doctor + Receptionist
- `prescription.processed`

### Generic notification
- `notification.new`

---

# Notification Emit Logic

Shared helpers:

- `utils/realtime.js`
- `utils/notificationService.js`

## `createNotificationsForRole(...)`

Use case:

- role-based notification
- e.g. all medical users

## `createNotificationForUser(...)`

Use case:

- single doctor notification

---

# Implemented Workflow APIs

## Doctor

- `POST /api/v1/doctors/consultations`
- `GET /api/v1/doctors/consultations/:appointment_id`

Doctor consultation create hote hi prescription direct medical workflow me chali jati hai.

## Receptionist

- `GET /api/v1/receptionist/prescriptions`
- `GET /api/v1/receptionist/prescriptions/:consultation_id`

Receptionist prescription APIs read-only hain.

## Medical

- `GET /api/v1/medical/prescriptions`
- `GET /api/v1/medical/prescriptions/:consultation_id`
- `POST /api/v1/medical/prescriptions/:consultation_id/pricing`
- `POST /api/v1/medical/prescriptions/:consultation_id/process`

## Notifications

- `GET /api/v1/notifications`
- `PATCH /api/v1/notifications/:notification_id/read`
- `PATCH /api/v1/notifications/read-all`

---

# Patient Visibility Rule

Patient `GET /api/v1/appointments/my` me prescription tab dekh sakta hai jab workflow status ho:

- `READY_FOR_MEDICAL`
- `PROCESSED_BY_MEDICAL`

---

# Frontend Real-Time Flow

## Receptionist frontend

Listen:

- `socket.connected`
- `notification.new`

Action:

- consulted/processed counts refresh
- list refresh when needed

## Medical frontend

Listen:

- `notification.new`
- `prescription.ready_for_medical`

Action:

- queue refresh
- badge increment

## Doctor frontend

Listen:

- `notification.new`
- `prescription.processed`

Action:

- workflow status refresh

---

# Suggested Socket.IO Frontend Example

```js
const socket = io("http://localhost:3000", {
  auth: {
    token: accessToken
  }
});

socket.on("socket.connected", (payload) => {
  console.log("connected", payload);
});

socket.on("prescription.ready_for_medical", (payload) => {
  console.log("medical queue update", payload);
});
```

---

# Important Files

- `server.js`
- `utils/realtime.js`
- `utils/notificationService.js`
- `controllers/v1/doctorController.js`
- `controllers/v1/receptionistController.js`
- `controllers/v1/medicalController.js`
- `controllers/v1/notificationController.js`
- `routes/v1/receptionistRoutes.js`
- `routes/v1/medicalRoutes.js`
- `routes/v1/notificationRoutes.js`

---

# Summary

This workflow now gives you:

- doctor → medical direct live handoff
- receptionist read-only prescription visibility
- persistent notifications
- patient-safe prescription visibility
- live role-based connection between doctor, receptionist, and medical
