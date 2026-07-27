# Socket.IO + Live Queue + Role-wise Live Data Guide

Ye file current backend implementation ke hisaab se explain karti hai:

- Socket.IO backend kaise kaam kar raha hai
- kaunse namespaces use ho rahe hain
- kaunse rooms bante hain
- kis role ko kis type ka live data milta hai
- `/live-queue` HTTP + socket flow kya hai
- frontend/backend me kya karna chahiye aur kya nahi
- current implementation me kaunse gaps/hardening points hain

Relevant files:

- `server.js`
- `utils/realtime.js`
- `services/liveQueueService.js`
- `services/liveQueueAutomationService.js`
- `services/doctorSessionService.js`
- `controllers/v1/liveQueueController.js`
- `controllers/v1/doctorSessionController.js`
- `controllers/v1/appointmentController.js`
- `controllers/v1/receptionistController.js`
- `controllers/v1/doctorController.js`
- `controllers/v1/medicalController.js`
- `utils/notificationService.js`
- `middleware/authMiddleware.js`
- `utils/roles.js`

---

## 1) High-level architecture

Backend me realtime 3 main channels par chal raha hai:

### A. Default authenticated namespace

Namespace: `/`

Use case:

- logged-in doctor
- logged-in receptionist
- logged-in medical
- logged-in patient
- internal staff dashboards

Is namespace me JWT socket auth mandatory hai.

### B. Public live queue namespace

Namespace: `/live-queue`

Use case:

- LED display
- TV display
- kiosk
- public queue board
- unauthenticated screen

Is namespace me JWT required nahi hai.
Ye sirf subscribe/unsubscribe + read-only live updates ke liye hai.

### C. Public doctor status namespace

Namespace: `/public-status`

Use case:

- doctor available hai ya nahi
- doctor in/out status board

Ye live queue detail nahi deta. Ye sirf doctor session status push karta hai.

Important:

- `/public-status` aur `GET /api/v1/public/doctor-status` **doctor status display** ke liye hain
- appointment booking allow/block ka rule yahan se derive nahi karna chahiye
- booking ke liye separate availability endpoint use karo:
  - `GET /api/v1/public/doctor-booking-availability`
  - active leave present ho to block
  - leave cancel ho chuki ho to booking allow

---

## 2) Default socket auth flow

File: `server.js`

Default namespace me connect karte waqt server ye karta hai:

1. token handshake se leta hai:
   - `socket.handshake.auth.token`
   - ya `Authorization: Bearer <token>`
2. JWT verify karta hai
3. `master_users` se active user fetch karta hai
4. normalized role banata hai
5. `socket.user` attach karta hai

Connected hone ke baad auto rooms:

- `user:<userId>`
- `role:<role_code>`

Example:

- doctor → `role:DOC`
- receptionist → `role:REC`
- medical → `role:MED`
- patient → `role:PAT`

Connect hone par server:

- `socket.connected`

emit karta hai.

Example payload:

```json
{
  "success": true,
  "user_id": 12,
  "role": "doctor",
  "role_code": "DOC"
}
```

---

## 3) Realtime helper layer ka actual kaam

File: `utils/realtime.js`

Yaha 5 important emit patterns hain:

### `emitToRole(role, eventName, payload)`

Room: `role:<role>`

Use currently mainly for:

- `doctor.appointments.updated`

### `emitToUser(userId, eventName, payload)`

Room: `user:<userId>`

Use currently for:

- `notification.new`
- `prescription.ready_for_medical`
- `prescription.processed`

Important:
Role-based notification bhi final emit `user:<id>` room par hi hota hai.
Matlab `createNotificationsForRole(...)` pehle DB se users nikalta hai, phir har user ko individually emit karta hai.

### `emitToRoom(roomName, eventName, payload)`

Generic room emit.

### `emitToLiveQueueRoom(roomName, eventName, payload)`

Ye special helper hai.
Ye same event ko dono jagah emit karta hai:

- authenticated default namespace
- public `/live-queue` namespace

Isliye ek hi queue event staff UI aur public display dono ko mil sakta hai.

### `emitDoctorSessionUpdate(payload)`

Ye `doctor.session.updated` ko dono jagah bhejta hai:

- default namespace
- `/public-status`

---

## 4) Live queue room naming convention

File: `services/liveQueueService.js`

3 room patterns use ho rahe hain:

### Slot-specific room

```text
live-queue:{branchId}:{slotId}:{appointmentDate}
```

Example:

```text
live-queue:1:3:2026-05-23
```

### Branch + date room

```text
live-queue:{branchId}:date:{appointmentDate}
```

Example:

```text
live-queue:1:date:2026-05-23
```

### Global date room

```text
live-queue:date:{appointmentDate}
```

Example:

```text
live-queue:date:2026-05-23
```

Important:
`emitLiveQueueEvent(...)` ek event ko in teeno room scopes par emit karta hai.
Iska matlab frontend apni need ke hisaab se narrow ya broad subscription choose kar sakta hai.

---

## 5) Socket subscribe / unsubscribe flow

File: `server.js`

Default namespace aur public `/live-queue` namespace dono me:

- `live-queue.subscribe`
- `live-queue.unsubscribe`

supported hain.

Payload:

```json
{
  "branch_id": 1,
  "slot_id": 3,
  "appointment_date": "2026-05-23"
}
```

Behavior:

- `appointment_date` required hai
- `slot_id` ho to slot room join hota hai
- `slot_id` na ho to date room join hota hai
- ack callback me `success` aur `room` return hota hai

Example ack:

```json
{
  "success": true,
  "room": "live-queue:1:3:2026-05-23"
}
```

---

## 6) `/live-queue` HTTP module kya karta hai

Route file: `routes/v1/liveQueueRoutes.js`

Public GET routes:

- `GET /api/v1/live-queue/current-date-tokens`
- `GET /api/v1/live-queue/:slot_id`

Protected mutation routes:

- `POST /api/v1/live-queue/:slot_id/session/start`
- `POST /api/v1/live-queue/:slot_id/session/end`
- `POST /api/v1/live-queue/:slot_id/call-next`
- `POST /api/v1/live-queue/appointments/:appointment_id/check-in`
- `POST /api/v1/live-queue/appointments/:appointment_id/call`
- `POST /api/v1/live-queue/appointments/:appointment_id/start`
- `POST /api/v1/live-queue/appointments/:appointment_id/complete`
- `POST /api/v1/live-queue/appointments/:appointment_id/skip`
- `POST /api/v1/live-queue/appointments/:appointment_id/reassign`

Authorization rule:

- direct role `doctor`
- ya `RECEPTION` module access

Iska practical meaning:

- doctor allowed
- receptionist allowed
- medical tabhi allowed jab uske paas cross-module reception access ho
- patient allowed nahi

Branch-scoped roles (`DOC`, `REC`, `MED`) ke liye selected branch enforcement bhi laga hua hai.

---

## 7) Live queue snapshot me kya milta hai

Main source:

- `getLiveQueueSnapshot(...)`
- `getCurrentDateTokenList(...)`

Important output fields:

- `session`
- `current_running_token`
- `next_ready_token`
- `waiting_queue`
- `ready_queue`
- `called_queue`
- `not_arrived_queue`
- `service_pipeline`
- `active_queue`
- `totals`
- `drift_minutes`
- `planned_start_at` / `planned_end_at`
- `scheduled_start_time` / `scheduled_end_time`

### Queue statuses

Backend statuses:

- `BOOKED`
- `CHECKED_IN`
- `WAITING`
- `IN_PROGRESS`
- `COMPLETED`
- `CANCELLED`
- `NO_SHOW`
- `SKIPPED`

### Queue buckets

UI-friendly grouping:

- `IN_PROGRESS`
- `READY`
- `CALLED`
- `NOT_ARRIVED`

### Important token meaning

- `original_token_number` = patient-facing fixed token
- `current_token_number` = runtime queue ordering
- `display_token_display` = patient ko dikhane ke liye preferred
- `current_token_display` = ops/internal runtime display
- `slot_start_time` / `slot_end_time` = slot ka fixed window
- `scheduled_start_time` / `scheduled_end_time` = appointment ka actual planned turn time based on cumulative previous durations

Example:

- token 1 duration `15` min
- token 2 duration `2` min
- token 3 `scheduled_start_time` = slot start + `17` min

Important:
`current_token_number` ko patient token samajhkar display mat karo.

---

## 8) Live queue event list

Live queue side se current implementation me ye events emit hote hain:

- `queue-updated`
- `doctor-session-started`
- `doctor-session-completed`
- `token-called`
- `consultation-started`
- `consultation-completed`
- `appointment-cancelled`
- `token-shifted`

Important behavior:
`emitLiveQueueEvent(...)` agar specific event emit kare, to mostly saath me `queue-updated` bhi emit hota hai.

Isliye safest frontend rule hai:

- incoming event type dekh lo
- but UI state ko payload snapshot se replace karo

---

## 9) Role-wise live data exactly kaise dikhta hai

## 9.1 Doctor

Doctor default authenticated namespace par:

- `socket.connected`
- `doctor.appointments.updated`
- `doctor.session.updated`
- live queue events (agar `live-queue.subscribe` kare)
- `prescription.processed` (agar medical ne doctor ki consultation process ki)
- `notification.new` (user-targeted notifications ho to)

Doctor ko live queue me:

- own branch/slot queue dekhne ke liye GET + socket use karna chahiye
- mutation endpoints allowed hain

Doctor appointment updates ka source:

- patient booking
- receptionist booking
- receptionist approval/payment flow

Important caveat:
`doctor.appointments.updated` current code me `role:DOC` room par broadcast hota hai.
Branch-specific filtering backend emit level par nahi hai.
To frontend ko payload ke `branch_id` / filters ke hisaab se ignore/apply karna chahiye.

## 9.2 Receptionist

Receptionist default authenticated namespace par:

- `socket.connected`
- `doctor.session.updated`
- live queue events (agar queue subscribe kare)
- `prescription.processed`
- `notification.new`

Receptionist ke liye important realtime areas:

- queue board
- check-in / call / skip / reassign flow
- doctor availability
- medical processed prescription status

Receptionist live queue mutate kar sakta hai.

## 9.3 Medical

Medical default authenticated namespace par:

- `socket.connected`
- `doctor.session.updated`
- live queue events technically receive kar sakta hai if subscribed
- `prescription.ready_for_medical`
- `notification.new`

Medical ka main realtime business flow:

1. doctor consultation save karta hai
2. medical ko `prescription.ready_for_medical` milta hai
3. medical process karta hai
4. doctor + receptionist ko `prescription.processed` milta hai

Important:
Medical role by default reception-style live queue mutation ke liye allowed nahi hai,
unless cross-module access configured ho.

## 9.4 Patient

Patient default authenticated namespace join kar sakta hai aur `role:PAT` room me aata hai,
lekin current code me patient role ke liye dedicated queue socket events emit nahi ho rahe.

Patient-facing queue ke liye practical options:

- public `/live-queue` namespace
- public GET queue APIs
- patient appointment REST APIs

Patient can technically live queue room subscribe kar sakta hai agar frontend usse allow kare,
lekin ye main designed path nahi lagta.

## 9.5 Public display / TV / kiosk

Public display ke liye:

- namespace `/live-queue`
- no JWT
- only subscribe/unsubscribe
- read-only queue updates

Public doctor availability ke liye:

- `GET /api/v1/public/doctor-status`
- namespace `/public-status`
- events:
  - `doctor.session.current`
  - `doctor.session.updated`

Best use cases:

- now serving board
- ready queue board
- doctor in/out banner

Never use public namespace for mutation.

---

## 10) Common realtime business flows

## 10.1 Appointment create

Sources:

- patient booking
- receptionist booking

Effects:

- `queue-updated`
- `doctor.appointments.updated`

Meaning:

- queue board refresh
- doctor appointment list refresh

## 10.2 Check-in

When receptionist/doctor checks in:

- appointment `CHECKED_IN`
- `checked_in_at` fill hota hai
- `arrival_sequence` fill hota hai
- `queue-updated` emit hota hai

Meaning:

- patient ready queue logic me aa sakta hai

## 10.3 Call next

Endpoint:

- `POST /api/v1/live-queue/:slot_id/call-next`

Backend logic:

- checked-in patients me se next candidate choose hota hai
- current implementation basis:
  - lowest `current_token_number`
  - then arrival sequence
  - then checked-in time

Emits:

- `token-called`
- `queue-updated`

## 10.4 Consultation start

Effects:

- queue status `IN_PROGRESS`
- live queue current running token update
- `consultation-started`
- `queue-updated`

## 10.5 Consultation complete

Effects:

- queue status `COMPLETED`
- session current token clear
- `consultation-completed`
- `queue-updated`

Automation:

- backend `scheduleAutoCallNext(...)` chalata hai
- default delay `5000ms`

Matlab agar next ready patient hai to auto call-next ho sakta hai.

## 10.6 Doctor session pause/resume

Doctor session service:

- `doctor.session.updated` emit karta hai
- pause par queue sessions pause side-effect le sakte hain
- resume par queued auto-next schedule ho sakta hai

## 10.7 Prescription workflow

Doctor completes consultation:

- medical ko `prescription.ready_for_medical`

Medical processes prescription:

- receptionist ko `prescription.processed`
- concerned doctor ko `prescription.processed`

Important:
Ye role room broadcast nahi, targeted user emits hain.

---

## 11) Current implementation ki important observations

### 11.1 Good design points

- queue snapshot backend source of truth hai
- public aur authenticated queue namespace separate hain
- role room + user room dono model available hain
- live queue events full snapshot ke saath aate hain
- queue mutation APIs protected hain
- branch-scoped protected HTTP flow already implemented hai

### 11.2 Current practical caveats

#### A. Socket subscribe me branch authorization hard check nahi hai

Default namespace par authenticated user `live-queue.subscribe` call kar sakta hai.
Server currently sirf date/integer validation karta hai.
Ye verify nahi karta ki user ko us branch/slot ka access hona chahiye ya nahi.

Recommended hardening:

- default namespace subscription me branch access check add karo
- patient ko allowed room scope explicitly restrict karo
- doctor/receptionist/medical ke liye selected branch scope enforce karo

#### B. `doctor.appointments.updated` branch filtered nahi hai

Current emit:

- `emitToRole('DOC', 'doctor.appointments.updated', payload)`

Isliye saare connected doctors event receive kar sakte hain.

Recommended:

- doctor-branch room banao, e.g. `doctor-branch:{branchId}`
- ya frontend branch filter compulsory rakho

#### C. `doctor.session.updated` bhi global style emit hai

Ye default namespace ke sab connected users ko mil sakta hai.

Recommended:

- agar UI branch/doctor specific hai to payload filter lagao
- future me branch/doctor rooms add karo

#### D. Medical role code alias ka dhyan rakho

`utils/roles.js` me `MED` aur `MEDS` alias support dikh raha hai.
Lekin workflow notifications usually `roleCode: 'MED'` use kar rahe hain.

Recommended:

- DB role codes ko standardize karo
- `MED` vs `MEDS` mismatch avoid karo

---

## 12) Kya karna chahiye

### Frontend side

1. initial load hamesha GET snapshot se lo
2. socket event aane par local guessed patching ke bajay snapshot replace karo
3. patient-facing token ke liye `display_token_display` use karo
4. runtime sorting ke liye `live_queue_position` use karo
5. ready/called/not-arrived ko backend buckets se hi dikhayo
6. branch-specific screen me incoming payload branch filter karo
7. LED/public display ke liye `/live-queue` namespace use karo
8. doctor availability ke liye `/public-status` use karo
9. protected live queue POST me bearer token bhejo
10. subscribe ke baad ack verify karo
11. room change par unsubscribe karo
12. reconnect ke baad dubara subscribe karo

### Backend side

1. socket subscription me branch authorization add karo
2. branch-specific rooms introduce karo
3. patient socket permissions tighten karo
4. room naming conventions ko docs me stable rakho
5. important emits me event schema versioning consider karo
6. namespace-wise rate limiting / abuse protection add karo
7. `MED` / `MEDS` standardize karo
8. logs/metrics add karo:
   - active sockets
   - room subscriptions
   - failed subscribe attempts
   - auto-next actions

---

## 13) Kya nahi karna chahiye

1. frontend me khud next patient decide mat karo
2. `current_token_number` ko patient-visible token mat dikhao
3. public `/live-queue` namespace se mutation expect mat karo
4. local array reorder logic se queue truth maintain mat karo
5. `queue-updated` ke bina stale state par भरोसा mat karo
6. branch-specific UI me every event blindly render mat karo
7. public screen par JWT namespace unnecessary mat use karo
8. mutation ke liye socket custom write events add mat karo jab HTTP protected routes already source of truth hain
9. medical user ko default se reception queue control assume mat karo
10. socket room name hardcode karke backend logic duplicate mat karo; helper conventions follow karo

---

## 14) Best recommended integration pattern

### Public queue page

- initial:
  - `GET /api/v1/live-queue/:slot_id`
- realtime:
  - connect `/live-queue`
  - `live-queue.subscribe`
  - listen:
    - `queue-updated`
    - `token-called`
    - `consultation-started`
    - `consultation-completed`

### Doctor / receptionist live queue page

- initial:
  - protected dashboard data + queue snapshot
- realtime:
  - default JWT namespace
  - `live-queue.subscribe`
  - listen:
    - live queue events
    - `doctor.session.updated`
    - doctor ke case me `doctor.appointments.updated`

### Medical workflow page

- default JWT namespace
- listen:
  - `notification.new`
  - `prescription.ready_for_medical`
- optionally queue subscribe only if operationally needed

---

## 15) One-line summary

Current backend architecture me:

- queue ka truth backend snapshot hai
- public display ke liye `/live-queue`
- logged-in staff ke liye default JWT namespace
- doctor availability ke liye `/public-status`
- doctor list updates role room par
- notifications/prescription events user room par
- live queue mutations sirf protected HTTP endpoints se honi chahiye
