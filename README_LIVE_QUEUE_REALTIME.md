# Live Queue Realtime API README

Ye document live queue / LED display / realtime token flow ke implemented backend design aur APIs explain karta hai.

## Base URL

```text
http://localhost:3000/api/v1/live-queue
```

## Auth

Live queue module ko separate/public module ke tarah expose kiya gaya hai.

- **GET snapshot/list APIs public reh sakti hain**
- **State-changing POST APIs ab protected hain**
  - allowed roles: `doctor`, `receptionist`
  - `Authorization: Bearer <ACCESS_TOKEN>` required
- Frontend directly current-date token list aur live queue snapshot fetch kar sakta hai
- Queue responses me numeric token ke saath display-friendly `token_display` fields bhi diye ja sakte hain:
  - morning slot → `M-<number>`
  - evening slot → `E-<number>`

## New Dynamic Queue Behavior Summary

Backend ab additive compatibility model follow karta hai:

- `original_token_number` = patient-facing fixed token identity
- `current_token_number` = runtime/legacy queue ordering field
- `display_token_number` / `display_token_display` = frontend ke liye recommended token fields
- `checked_in_at` = actual patient arrival/check-in time
- `arrival_sequence` = check-in capture order
- `queue_bucket` = `IN_PROGRESS` / `READY` / `CALLED` / `NOT_ARRIVED`
- `live_queue_position` = real-time serving position

Why:

- patient token stable dikhe
- existing skip/reassign/not-available flow break na ho
- ready patients aur not-arrived patients alag dikh sake
- live ETA sirf serviceable queue ke basis par nikle

## Required Migration

Live queue enable karne ke liye ye migration run karein:

- `sql/2026-05-14_live_queue_realtime.sql`
- `sql/2026-05-19_live_queue_dynamic_positions.sql`

## Realtime Design Summary

Backend me queue state centralized rakha gaya hai:

- appointment booking table = `tbl_appointments`
- queue runtime state = same appointment row ke extra fields
- doctor slot/day session = `tbl_live_queue_sessions`
- queue audit trail = `tbl_appointment_queue_events`
- websocket room = `live-queue:{branch_id}:{slot_id}:{appointment_date}`

React frontend integration guide:

- `README_LIVE_QUEUE_FRONTEND_SOCKET_INTEGRATION_REACT.md`

## Important Queue Fields

`tbl_appointments` me:

- `queue_status`
- `planned_start_at`
- `planned_end_at`
- `actual_called_at`
- `actual_started_at`
- `actual_completed_at`
- `last_queue_event_at`
- `checked_in_at`
- `arrival_sequence`

`master_slots` me:

- `default_consult_minutes`

`master_treatments` me:

- `estimated_duration_minutes`

## Supported Queue Statuses

- `BOOKED`
- `CHECKED_IN`
- `WAITING`
- `IN_PROGRESS`
- `COMPLETED`
- `CANCELLED`
- `NO_SHOW`
- `SKIPPED`

Live queue response me sirf active queue statuses return hote hain:

- `BOOKED`
- `CHECKED_IN`
- `WAITING`
- `IN_PROGRESS`

## Socket Subscription

Client ko authenticated Socket.IO connection ke baad room join karna hoga:

### Subscribe

Event:

```text
live-queue.subscribe
```

Payload:

```json
{
  "branch_id": 1,
  "slot_id": 3,
  "appointment_date": "2026-05-14"
}
```

### Unsubscribe

Event:

```text
live-queue.unsubscribe
```

Payload same rahega.

## Emitted Realtime Events

- `queue-updated`
- `doctor-session-started`
- `doctor-session-completed`
- `token-called`
- `consultation-started`
- `consultation-completed`
- `appointment-cancelled`
- `token-shifted`

Har event payload me latest queue snapshot bhi aata hai.

## Implemented APIs

1. `GET /api/v1/live-queue/:slot_id`
2. `GET /api/v1/live-queue/current-date-tokens`
3. `POST /api/v1/live-queue/:slot_id/session/start`
4. `POST /api/v1/live-queue/:slot_id/session/end`
5. `POST /api/v1/live-queue/:slot_id/call-next`
6. `POST /api/v1/live-queue/appointments/:appointment_id/check-in`
7. `POST /api/v1/live-queue/appointments/:appointment_id/call`
8. `POST /api/v1/live-queue/appointments/:appointment_id/start`
9. `POST /api/v1/live-queue/appointments/:appointment_id/complete`
10. `POST /api/v1/live-queue/appointments/:appointment_id/skip`
11. `POST /api/v1/live-queue/appointments/:appointment_id/reassign`

---

## 1) Get Live Queue

### Endpoint

```http
GET /api/v1/live-queue/:slot_id?branch_id=1&appointment_date=2026-05-14
```

### Purpose

Slot/day ka current queue snapshot return karta hai.

### Response highlights

- current running token
- current patient
- waiting queue
- ready queue
- called queue
- not-arrived queue
- service pipeline
- next ready token
- display token fields
- queue bucket + live queue position
- estimated start/end times
- drift minutes
- session status

---

## 2) Current Date Tokens List

### Endpoint

```http
GET /api/v1/live-queue/current-date-tokens
```

### Optional Query Params

- `branch_id`
- `slot_id`
- `appointment_date`  
  agar nahi bhejo to automatically **aaj ki date** use hoti hai

### Purpose

Direct current-date token list with token details return karta hai.

### Important behavior

Ye API intentionally **sirf active queue items** return karti hai:

- `BOOKED`
- `CHECKED_IN`
- `WAITING`
- `IN_PROGRESS`

Isliye doctor consultation complete hote hi:

- backend `queue_status = COMPLETED` set karta hai
- websocket `queue-updated` / `consultation-completed` emit hota hai
- next API hit ya latest socket snapshot me wo appointment list se automatically hat jata hai

### Example

```http
GET /api/v1/live-queue/current-date-tokens?branch_id=1&slot_id=3
```

### Response

- flat `tokens` list
- `groups` by branch/slot
- patient details
- token number
- queue status
- planned/actual times

---

## 3) Start Doctor Session

### Endpoint

```http
POST /api/v1/live-queue/:slot_id/session/start
```

### Request JSON

```json
{
  "branch_id": 1,
  "appointment_date": "2026-05-14"
}
```

### Notes

- session row create/update hota hai
- socket event: `doctor-session-started`

---

## 4) Call Next Ready Token

### Endpoint

```http
POST /api/v1/live-queue/:slot_id/call-next
```

### Request JSON

```json
{
  "branch_id": 1,
  "appointment_date": "2026-05-14"
}
```

### Logic

- sirf checked-in/ready patients consider honge
- lowest `current_token_number` among ready patients call hoga
- patient-facing display ke liye frontend `display_token_display` use kare
- ye endpoint legacy manual `/call` ko replace nahi karta, but preferred realtime flow hai
- manual call-next existing auto-scheduled call-next timer ko cancel kar deta hai

---

## Auto queue progression

Implemented behavior:

- check-in par queue snapshot immediately update hota hai
- check-in par auto call-next nahi hota
- consultation complete par backend **5 seconds delay** ke baad auto call-next try karta hai
- doctor session pause hone par auto call-next blocked hota hai
- doctor session resume/start hone par backend **3 seconds delay** ke baad auto call-next try kar sakta hai

Current implementation note:

- delayed auto-next timer abhi **same Node process memory** me scheduled hota hai
- agar server restart ho jaye to pending delayed timer drop ho sakta hai

Important pause rule:

- consult form open hona consult start nahi maana jayega
- sirf persisted `IN_PROGRESS` appointment ko current consultation maana jayega
- pause ke time agar no `IN_PROGRESS` hai to current running token clear/hold rahega

---

## 5) End Doctor Session

### Endpoint

```http
POST /api/v1/live-queue/:slot_id/session/end
```

### Request JSON

```json
{
  "branch_id": 1,
  "appointment_date": "2026-05-14"
}
```

### Notes

- current running token clear hota hai
- socket event: `doctor-session-completed`

---

## Response Field Notes for Frontend

New recommended usage:

- token badge / patient token → `display_token_display`
- runtime ordering chip → `current_token_display` ya `current_token_number`
- live row group → `queue_bucket`
- queue rank → `live_queue_position`
- ready-only rank → `ready_queue_position`
- service ETA → `live_estimated_start_at`, `live_estimated_end_at`, `live_estimated_wait_minutes`

Important:

- `original_token_number` ko mutate nahi samjho; ye patient-facing identity hai
- `current_token_number` abhi compatibility/runtime field hai
- ready queue aur not-arrived queue ko UI me separate dikhana recommended hai

---

## 5) Check-in Appointment

### Endpoint

```http
POST /api/v1/live-queue/appointments/:appointment_id/check-in
```

### Result

- `queue_status = CHECKED_IN`
- socket event: `queue-updated`

---

## 6) Call Token

### Endpoint

```http
POST /api/v1/live-queue/appointments/:appointment_id/call
```

### Result

- current token session me set hota hai
- `actual_called_at` set hota hai
- socket event: `token-called`

---

## 7) Start Consultation in Queue

### Endpoint

```http
POST /api/v1/live-queue/appointments/:appointment_id/start
```

### Result

- `queue_status = IN_PROGRESS`
- `actual_started_at = NOW()`
- socket event: `consultation-started`

---

## 8) Complete Consultation in Queue

### Endpoint

```http
POST /api/v1/live-queue/appointments/:appointment_id/complete
```

### Result

- `queue_status = COMPLETED`
- `actual_completed_at = NOW()`
- socket event: `consultation-completed`

> Note: ye endpoint live queue runtime complete karta hai. Doctor consultation save API alag se medical prescription flow ke liye same rahegi.

---

## 9) Skip Token

### Endpoint

```http
POST /api/v1/live-queue/appointments/:appointment_id/skip
```

### Request JSON

```json
{
  "reason": "Patient not present"
}
```

### Result

- token queue ke end me move hota hai
- future tokens compact hote hain
- socket event: `token-shifted`

---

## 10) Reassign Token

### Endpoint

```http
POST /api/v1/live-queue/appointments/:appointment_id/reassign
```

### Request JSON

```json
{
  "token_number": 5,
  "reason": "VIP adjustment"
}
```

### Result

- target appointment requested token pe move hota hai
- impacted tokens auto shift hote hain
- socket event: `token-shifted`

---

## Actual Runtime Flow

Recommended runtime flow:

1. appointment book hota hai → `queue_status = BOOKED`
2. patient aata hai → `check-in`
3. doctor slot start karta hai → `session/start`
4. doctor/receptionist token call karta hai → `call`
5. doctor consult start karta hai → `start`
6. doctor prescription save karta hai (`POST /doctors/consultations`)
   - appointment status `Completed`
   - queue status bhi `COMPLETED`
   - socket event bhi emit hota hai
7. agar patient absent ho to `skip`
8. agar manual token adjust karna ho to `reassign`

## Existing Flow Compatibility

Existing flows intentionally break nahi kiye gaye:

- patient appointment booking flow same
- receptionist booking / approval / rejection / reschedule same
- doctor consultation save flow same
- billing flow same

Extra live queue hooks automatically add kiye gaye hain:

- appointment create
- appointment cancel
- receptionist reject/approve
- not-available / reschedule
- consultation complete

## ETA Logic

System ab **treatment ke `estimated_duration_minutes`** ko primary scheduling basis maanta hai.
Fallback sirf tab hota hai jab treatment duration missing/invalid ho:

- primary duration = `master_treatments.estimated_duration_minutes`
- fallback duration = `master_slots.default_consult_minutes`
- planned time = slot start + previous appointment durations ka cumulative sum
- actual delay/advance = live drift
- displayed ETA = recalculated realtime estimate

Isliye LED display ko frontend side pe business logic carry karne ki zarurat nahi hai.
