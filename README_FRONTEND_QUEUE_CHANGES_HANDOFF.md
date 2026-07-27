# Frontend Handoff: Latest Queue / Token Management Changes

Ye document frontend team ke liye bana hai taaki wo easily samajh sake:

- backend me kya latest changes huye
- kis module me kya impact hai
- ye changes kyu kiye gaye
- frontend ko kya update karna hai
- backward compatibility kaise behave karegi

---

# 1) High-level Summary

Backend me queue/token system ko **additive upgrade** diya gaya hai.

Purana behavior:

- `current_token_number` ko hi mostly token display + runtime queue order maana ja raha tha
- skip / reassign / not-available me queue runtime renumber hoti thi

Naya recommended frontend behavior:

- **patient-facing token** = fixed display token
- **runtime queue order** = separate live position / ready queue

Isliye backend ne naye fields add kiye hain jo frontend ko token identity aur live order ko alag handle karne dete hain.

---

# 2) Core Concept Change

## Old mindset

`current_token_number` = sab kuch

- patient token
- queue order
- next patient
- display

## New mindset

Do alag cheezein samjho:

### A. Fixed patient token

Patient ko jo token dikhana hai wo stable hona chahiye.

Recommended fields:

- `display_token_number`
- `display_token_display`

### B. Live runtime queue

Doctor abhi kisko dekhega, kaun ready hai, kaun late hai, kaun not arrived hai — ye alag layer hai.

Recommended fields:

- `queue_bucket`
- `live_queue_position`
- `ready_queue_position`
- `ready_queue`
- `called_queue`
- `not_arrived_queue`

---

# 3) Why these changes were done

Ye changes isliye kiye gaye:

1. **patient confusion kam ho**
   - “mera token 2 tha, 5 kaise ho gaya?” type problem reduce karne ke liye

2. **doctor / receptionist realtime queue better handle kar saken**
   - jo patient aa gaya usko queue me lao
   - jo nahi aaya usko not-arrived rakho

3. **existing backend flow break na ho**
   - old `current_token_number` logic still available hai

4. **frontend ko richer queue state mile**
   - sirf flat list ke badle grouped runtime state mile

5. **public board aur mutation APIs alag secure hon**
   - TV/display read-only रहे
   - queue mutation sirf authenticated staff करे

---

# 4) Module-wise Change Summary

## Module A: Live Queue API

### Kya change hua

Live queue snapshot me new fields aur new grouped queue sections add huye:

- `display_token_number`
- `display_token_display`
- `checked_in_at`
- `arrival_sequence`
- `queue_bucket`
- `live_queue_position`
- `ready_queue_position`
- `ready_queue`
- `called_queue`
- `not_arrived_queue`
- `service_pipeline`
- `next_ready_token`

### Why

Frontend ko ab flat active queue ke instead actual realtime display-ready structure mile.

### Frontend handling

Use this:

- **patient token badge** → `display_token_display`
- **ops/internal token info** → `current_token_display` or `current_token_number`
- **render current patient** → `current_running_token`
- **render next waiting people** → `ready_queue`
- **render absent/not reached people** → `not_arrived_queue`

### Important note

`waiting_queue` aur `active_queue` abhi bhi available hain compatibility ke liye, but new UI should prefer grouped queues.

---

## Module B: Live Queue Mutation APIs

### Kya change hua

State-changing live queue routes ab protected hain.

Affected POST actions:

- session start
- session end
- check-in
- manual call
- consultation start
- consultation complete
- skip
- reassign
- new `call-next`

### Why

Pehle public endpoint misuse risk tha. Ab sirf authenticated `doctor` ya `receptionist` mutation kar sakte hain.

### Frontend handling

#### Public display / LED page

- only GET APIs call kare
- public socket namespace use kare
- POST mutation bilkul na kare

#### Doctor / receptionist panel

- protected POST endpoints par bearer token bheje
- mutation ke baad backend snapshot se UI refresh/reconcile kare

---

## Module C: New `call-next` flow

### Kya change hua

New endpoint:

`POST /api/v1/live-queue/:slot_id/call-next`

### Behavior

- checked-in / ready patients me se next patient choose hota hai
- currently lowest runtime token among ready patients pick hota hai
- response me latest snapshot milta hai

### Why

Frontend ko khud “next kaun hai?” decide nahi karna chahiye.  
Backend ko source of truth banaya gaya hai.

### Frontend handling

Doctor/receptionist UI me:

- “Call Next” button is endpoint ko hit kare
- local sorting se next patient choose mat karo
- backend snapshot aane par state replace karo
- agar manual call-next click hua ho to pending auto-next ko backend ignore/cancel kar dega

---

## Module D: Check-in / arrival tracking

### Kya change hua

New runtime fields:

- `checked_in_at`
- `arrival_sequence`

### Why

Patient kab actual aaya aur ready hua uski runtime trace maintain karne ke liye.

Ye future me useful hai:

- late arrival handling
- ready queue reasoning
- realtime ordering explanation

### Frontend handling

Frontend isko use kar sakta hai:

- “Arrived at” timestamp display
- patient status tag
- receptionist desk pe arrival-based insights

Ye fields display optional hain, but queue debugging aur staff UI me useful rahenge.

---

## Module E: Queue grouping

### Kya change hua

Backend ab queue items ko runtime bucket me classify karta hai:

- `IN_PROGRESS`
- `READY`
- `CALLED`
- `NOT_ARRIVED`

Field:

- `queue_bucket`

### Why

Pehle frontend ko manually infer karna padta tha ki kaun ready hai aur kaun absent.  
Ab backend directly batata hai.

### Frontend handling

Recommended UI sections:

1. **Now Serving**
   - `current_running_token`

2. **Ready / Waiting**
   - `ready_queue`

3. **Called / Near turn**
   - `called_queue`

4. **Not Arrived**
   - `not_arrived_queue`

---

## Module F: Token display logic

### Kya change hua

Utility layer me new display-friendly stable token output diya gaya:

- `display_token_number`
- `display_token_display`

### Why

`current_token_number` runtime me move ho sakta hai.  
Patient ko stable identity dikhane ke liye display token alag expose kiya gaya.

### Frontend handling

#### Patient-facing pages

Always prefer:

- `display_token_display`

#### Staff-facing pages

Show both if needed:

- fixed token → `display_token_display`
- runtime token/order → `current_token_display`

Example:

- Token: `M-2`
- Live Position: `4`

---

## Module G: Receptionist flow impact

### Kya change hua

Not-available / queue-reset style flows me runtime readiness fields reset ki ja sakti hain.

Affected runtime fields may be cleared:

- `checked_in_at`
- `arrival_sequence`
- `actual_called_at`

### Why

Agar patient absent tha aur later aayega to usko fresh check-in behavior mil sake.

### Frontend handling

Receptionist screen me:

- old arrival badge stale na rakho
- latest snapshot se row replace karo
- local cached ready/not-ready state par भरोसा mat karo

---

## Module H: Doctor flow impact

### Kya change hua

Doctor-facing APIs/docs me new queue metadata reflect ki gayi hai:

- `display_token_display`
- queue grouping fields
- arrival metadata

### Why

Doctor UI ko better queue clarity mile:

- kaun present hai
- kaun next hai
- kaun absent hai

### Frontend handling

Doctor appointment/list screens me:

- token badge update karo
- if live queue page hai to `ready_queue` consume karo
- if consultation UI me “next patient” action hai to `call-next` integrate karo

### Pause behavior clarification

Frontend ko ye rule samajhna zaroori hai:

- **form open != consultation started**
- pause button ka behavior backend persisted queue state par based hai

If doctor pauses before `IN_PROGRESS`:

- patient current running nahi maana jayega
- queue hold hogi
- patient ready/called state me rahega

If doctor pauses after `IN_PROGRESS`:

- same patient current consult context me preserve hoga
- resume ke baad same patient continue ho sakta hai

### Auto-next behavior now

- check-in par queue refresh hoti hai
- consult complete ke **5 sec** baad backend auto-next try karta hai
- pause state me auto-next nahi chalega
- resume/start ke **3 sec** baad backend auto-next try kar sakta hai, but only when no consult currently in progress
- delayed auto-next currently same backend process memory timer se hota hai

---

# 5) API Response Field Guide

## Old fields still available

- `token_number`
- `current_token_number`
- `original_token_number`
- `token_display`
- `current_token_display`
- `original_token_display`

## New recommended fields

### Identity/display

- `display_token_number`
- `display_token_display`

### Runtime state

- `queue_bucket`
- `live_queue_position`
- `ready_queue_position`
- `checked_in_at`
- `arrival_sequence`

### Grouped queue containers

- `current_running_token`
- `ready_queue`
- `called_queue`
- `not_arrived_queue`
- `service_pipeline`
- `next_ready_token`

### Runtime ETA

- `live_estimated_start_at`
- `live_estimated_end_at`
- `live_estimated_wait_minutes`

### Planned schedule ETA

- `planned_start_at`
- `planned_end_at`

---

# 6) Frontend Migration Guide

## Phase 1: Safe immediate changes

Frontend ye changes abhi kar sakta hai without risky rewrite:

1. token label ko `display_token_display` par shift karo
2. queue row me `queue_bucket` badge show karo
3. `ready_queue` aur `not_arrived_queue` alag section me render karo
4. POST mutation requests me auth token ensure karo

## Phase 2: Better live queue UX

1. “Call Next” button ko new `call-next` endpoint se connect karo
2. live position show karo
3. `live_estimated_wait_minutes` show karo

## Phase 3: Cleanup

1. local queue sorting logic reduce karo
2. backend snapshot ko source of truth banao
3. `current_token_number` ko patient token label ke liye use karna bandh karo

---

# 7) Recommended UI Mapping

## Patient-facing card

- Token → `display_token_display`
- Status → `queue_bucket`
- ETA → `live_estimated_wait_minutes` or `planned_start_at`

## Receptionist desk row

- Fixed Token → `display_token_display`
- Runtime Token → `current_token_display`
- Bucket → `queue_bucket`
- Arrived At → `checked_in_at`
- Live Position → `live_queue_position`

## Doctor queue screen

- Now Serving → `current_running_token`
- Next List → `ready_queue`
- Delayed/Absent → `not_arrived_queue`

## Public TV/LED screen

- Main token display → `current_running_token.display_token_display`
- upcoming tokens → `ready_queue[].display_token_display`
- absent users ko optionally hide ya separate low-priority section me show karo

---

# 8) What frontend should NOT do

Frontend ko ye kaam nahi karne chahiye:

1. `current_token_number` ko patient-facing permanent token maan lena
2. local sorting se final next patient decide karna
3. local mutation ke basis par guessed queue reorder maintain karna
4. public page se mutation POST calls karna
5. `ready_queue` ignore karke sirf `active_queue` par new UI build karna

---

# 9) Backward Compatibility

Important:

- existing fields remove nahi kiye gaye
- purana flow immediately break nahi hoga
- old frontend mostly chalega
- but new frontend ko new fields adopt karne chahiye for clarity

Compatibility summary:

| Area | Old Frontend | New Frontend Recommended |
|---|---|---|
| Token display | `current_token_display` | `display_token_display` |
| Queue rendering | `active_queue` / `waiting_queue` | `ready_queue`, `called_queue`, `not_arrived_queue` |
| Next patient action | manual local logic | backend `call-next` |
| Auth on queue POST | often assumed open | bearer token required |

---

# 10) Quick action list for frontend developer

## Must do

- [ ] token label ko `display_token_display` par shift karo
- [ ] protected POST calls me auth add karo
- [ ] live queue page me `ready_queue` use karo
- [ ] not-arrived patients ko separate handle karo

## Should do

- [ ] `call-next` integrate karo
- [ ] `queue_bucket` UI badges add karo
- [ ] `live_queue_position` show karo
- [ ] `live_estimated_wait_minutes` show karo

## Nice to have

- [ ] arrival timestamp show karo
- [ ] patient token + runtime token dual view staff page me dikhao

---

# 11) Final Recommendation

Frontend ka source of truth ye hona chahiye:

- **display token** alag
- **runtime queue** alag
- **backend snapshot final**

Simple rule:

> Patient ko fixed token dikhao, staff ko live queue dikhao, aur queue decision backend par chhodo.
