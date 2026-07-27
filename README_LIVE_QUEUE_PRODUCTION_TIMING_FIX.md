# Live Queue Production Timing Fix

## Problem Summary

Current live queue implementation token order ko correctly restore kar leti hai after refresh, but **runtime timing context** fully persist nahi hota. Is wajah se:

- token order API se aa jata hai
- queue status bhi aa jata hai
- but remaining queue ki timing kabhi kabhi **slot start time** ya `planned_*` values se rebuild ho jaati hai
- result: agar real queue 8:00 PM tak drift ho chuki ho, refresh ke baad UI 6:00 PM slot baseline ke aas-paas render kar sakti hai

In short:

> **Order survives, runtime clock resets.**

---

## Exact Root Cause

System me abhi do alag timing concepts mix ho rahe hain:

### 1. Planning time

- `planned_start_at`
- `planned_end_at`
- slot start time
- treatment estimated duration

Ye booking/initial planning ke liye useful hai.

### 2. Runtime time

- `actual_called_at`
- `actual_started_at`
- `actual_completed_at`
- check-in sequence
- actual live queue drift

Ye real-world queue progression ko represent karta hai.

Current snapshot generation refresh ke time plan aur runtime dono ko mix karta hai, aur kuch cases me runtime projection ko **reconstruct** karta hai instead of **reading persisted runtime ETA**.

---

## Production Goal

Refresh, reconnect, socket disconnect, server restart, ya horizontal scaling ke baad bhi:

1. **queue order same rahe**
2. **current running token same rahe**
3. **runtime ETA same rahe**
4. **auto-next durable ho**
5. **frontend local memory pe depend na kare**

---

## Recommended Production Design

## Core Principle

**Plan ko alag rakho, runtime ko alag persist karo.**

### Plan layer

Used for initial schedule:

- `planned_start_at`
- `planned_end_at`

### Runtime layer

Used for live queue display and progression:

- current queue clock
- live ETA start/end per token
- auto-next due time
- queue revision

Frontend ko live queue page par **runtime layer** serve honi chahiye.

---

## Proposed Database Changes

## 1) `tbl_live_queue_sessions`

Add these columns:

```sql
ALTER TABLE tbl_live_queue_sessions
  ADD COLUMN runtime_anchor_at DATETIME NULL AFTER session_ended_at,
  ADD COLUMN last_runtime_recalc_at DATETIME NULL AFTER runtime_anchor_at,
  ADD COLUMN auto_call_next_due_at DATETIME NULL AFTER last_runtime_recalc_at,
  ADD COLUMN auto_call_next_reason VARCHAR(100) NULL AFTER auto_call_next_due_at,
  ADD COLUMN queue_revision BIGINT NOT NULL DEFAULT 0 AFTER auto_call_next_reason;
```

### Meaning

- `runtime_anchor_at`  
  Current live queue clock ka persisted base time.

- `last_runtime_recalc_at`  
  Last time runtime ETA projection recompute hui.

- `auto_call_next_due_at`  
  Durable delayed auto-next schedule. Memory timer lose ho jaye tab bhi due time DB me rahe.

- `auto_call_next_reason`  
  Example: `AUTO_CALL_NEXT_AFTER_CONSULT_COMPLETE`, `AUTO_CALL_NEXT_AFTER_SESSION_RESUME`

- `queue_revision`  
  Har queue mutation par increment karo. Useful for debugging, stale UI detection, and worker idempotency.

---

## 2) `tbl_appointments`

Add these columns:

```sql
ALTER TABLE tbl_appointments
  ADD COLUMN live_estimated_start_at DATETIME NULL AFTER planned_end_at,
  ADD COLUMN live_estimated_end_at DATETIME NULL AFTER live_estimated_start_at,
  ADD COLUMN live_wait_minutes_snapshot INT NULL AFTER live_estimated_end_at,
  ADD COLUMN live_eta_updated_at DATETIME NULL AFTER live_wait_minutes_snapshot;
```

### Meaning

- `live_estimated_start_at`  
  Persisted runtime ETA start

- `live_estimated_end_at`  
  Persisted runtime ETA end

- `live_wait_minutes_snapshot`  
  Last computed wait snapshot for fast reads / debugging

- `live_eta_updated_at`  
  ETA last refresh timestamp

---

## What Should Not Change

Existing fields still valid rahenge:

- `actual_called_at`
- `actual_started_at`
- `actual_completed_at`
- `checked_in_at`
- `arrival_sequence`
- `planned_start_at`
- `planned_end_at`

Ye fields remove nahi karne. New runtime fields inke upar build honge.

---

## Runtime Calculation Model

## Rule 1: Slot time is only for initial planning

`planned_*` values sirf baseline hain.  
Refresh ke baad live queue render karne ke liye इन्हें primary source nahi banana.

## Rule 2: Runtime anchor persist karo

`runtime_anchor_at` should be updated from actual events:

- consultation start
- consultation complete
- auto-next schedule
- auto-next execution
- doctor resume

## Rule 3: Every active appointment gets persisted live ETA

Whenever queue changes, backend should recompute and persist:

- `live_estimated_start_at`
- `live_estimated_end_at`
- `live_wait_minutes_snapshot`

Iske baad snapshot API ko live ETA derive nahi karni chahiye unless recovery mode ho.

---

## New Service Flow

Create one dedicated service function:

### `recalculateLiveRuntimeProjection(connection, { branchId, slotId, appointmentDate, nowOverride })`

Responsibilities:

1. queue session lock karo
2. active appointments lock karo
3. current running token identify karo
4. runtime anchor decide karo
5. ready queue sort karo using:
   - `current_token_number`
   - `arrival_sequence`
   - `checked_in_at`
   - `appointment_id`
6. each token ka persisted live ETA update karo
7. session me `last_runtime_recalc_at` and `queue_revision` update karo

### Runtime anchor priority

1. current running token ka `actual_started_at`
2. if no running token, latest completed token ka `actual_completed_at`
3. else session `runtime_anchor_at`
4. else current time

---

## Durable Auto-Next Design

Current implementation:

- `setTimeout` in Node memory
- restart ke baad pending timer lost

Production implementation:

### On auto-next schedule

`completeConsultation()` aur doctor resume flow:

- session row me `auto_call_next_due_at = NOW() + interval`
- `auto_call_next_reason` set karo
- memory timer optional hai, but source of truth DB rahega

### Worker / scheduler

Run a periodic worker every 1-5 seconds:

### `processDueAutoCallNext()`

1. due sessions select karo:
   - `auto_call_next_due_at <= NOW()`
   - `session_status = RUNNING`
2. rows lock karo
3. ensure no `IN_PROGRESS` appointment
4. call `autoSelectAndCallNextReady(...)`
5. clear `auto_call_next_due_at`
6. recalc runtime projection
7. emit socket events

This makes auto-next survive:

- API refresh
- browser refresh
- socket reconnect
- Node restart
- multi-instance deployment

---

## Required Code Changes

## A) `services/liveQueueService.js`

### Keep

- `compareReadyQueueItems`
- `autoSelectAndCallNextReady`
- `getLiveQueueSnapshot`

### Change

1. add `recalculateLiveRuntimeProjection(...)`
2. update `getLiveQueueSnapshot()` to **read persisted `live_estimated_*` fields first**
3. keep derived runtime rebuild only as emergency fallback
4. update snapshot response to always return persisted runtime timestamps

## B) `services/liveQueueAutomationService.js`

### Change

1. `scheduleAutoCallNext()` should also persist:
   - `auto_call_next_due_at`
   - `auto_call_next_reason`
2. memory timer optional rakho, but not authoritative
3. add recovery-safe scheduler/worker integration

## C) `controllers/v1/liveQueueController.js`

After these mutations, call runtime projection recalc:

- `checkInAppointment`
- `callToken`
- `callNextReadyToken`
- `startConsultation`
- `completeConsultation`
- `skipToken`
- `reassignToken`

## D) `services/doctorSessionService.js`

### Resume

- `auto_call_next_due_at` set karo with 3-second delay
- runtime projection recalc karo

### Pause

- clear in-memory timer
- session remains persisted
- `auto_call_next_due_at = NULL`

---

## API Contract Recommendation

`getLiveQueueSnapshot()` response me these fields authoritative honi chahiye:

- `live_estimated_start_at`
- `live_estimated_end_at`
- `live_estimated_wait_minutes`
- `queue_revision`
- `last_runtime_recalc_at`

Frontend rules:

1. `planned_start_at` sirf informational
2. live screen par ETA ke liye `live_estimated_*` use karo
3. local client-side queue timing calculate mat karo
4. socket event ke payload ko authoritative server snapshot treat karo

---

## Real-Time Example

## Scenario

- Slot start: **6:00 PM**
- Queue drift ho chuki hai
- Token 4 actual consult start: **7:42 PM**
- Token 5 ready
- Token 6 ready

## What should happen

### At 7:42 PM

- Token 4 `actual_started_at = 2026-05-26 19:42:00`
- session `runtime_anchor_at = 2026-05-26 19:42:00`
- Token 5 `live_estimated_start_at = 8:00 PM` (example)
- Token 6 `live_estimated_start_at = 8:15 PM`

### At 7:58 PM browser refresh

Frontend API hit karega.  
Backend session + appointments se persisted runtime ETA read karega.

### Correct result

- Token 5 still around **8:00 PM**
- Token 6 still around **8:15 PM**
- queue 6:00 PM slot start par snap-back nahi karegi

---

## Rollout Plan

## Phase 1 - Safe schema rollout

1. new columns add karo
2. code backward-compatible rakho
3. old fields continue working

## Phase 2 - Dual write

Queue mutations par:

- existing behavior preserve karo
- new runtime fields bhi write karo

## Phase 3 - Snapshot switch

`getLiveQueueSnapshot()` ko persisted `live_estimated_*` fields pe switch karo.

## Phase 4 - Durable auto-next worker

- DB due-time based worker enable karo
- memory timer ko optimization-only mode me rakho

## Phase 5 - Cleanup

- if stable, reduce old derived fallback logic

---

## Backfill Strategy

For same-day active sessions:

1. current running token identify karo
2. if `actual_started_at` exists, use as runtime anchor
3. else latest completed token ka `actual_completed_at` use karo
4. else `NOW()` use karo
5. active ready queue ke live ETA backfill karo

This can be done via:

- one SQL migration script
- or one admin repair endpoint/script

---

## Acceptance Criteria

Solution tab complete mana jayega jab:

1. browser refresh ke baad ETA unchanged ya near-unchanged ho
2. server restart ke baad pending auto-next still execute ho
3. slot start time par snap-back na ho after runtime drift
4. paused session me no auto-next execution ho
5. resumed session me delayed auto-next durable ho
6. multi-instance deployment me duplicate auto-next na chale
7. frontend without local memory bhi same queue render kare

---

## Recommended New Files

1. `sql/2026-05-26_live_queue_runtime_projection.sql`
2. `services/liveQueueRuntimeService.js`
3. optional worker:
   - `services/liveQueueDueJobWorker.js`

---

## Final Recommendation

### Minimal fix is not enough for production

Because it only improves fallback order.

### Proper production fix is:

1. persist runtime queue clock in session
2. persist live ETA per appointment
3. persist durable auto-next due time
4. recalculate runtime projection after every queue mutation
5. serve persisted runtime ETA to frontend

This design ensures:

- refresh-safe
- restart-safe
- scale-safe
- consistent live queue rendering

---

## Suggested Next Implementation Step

Implementation order:

1. schema migration
2. `recalculateLiveRuntimeProjection` service
3. controller mutation integration
4. snapshot response switch
5. durable auto-next worker

If needed, next document can be created for:

- exact file-by-file patch plan
- SQL migration script
- controller/service pseudocode
- rollout checklist for QA/UAT
