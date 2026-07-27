# Frontend Handoff: Doctor Session Realtime Updates

## Why this doc

Backend me doctor session realtime behavior update kiya gaya hai so that:

- doctor dashboard refresh ke baad bhi current doctor session state mil sake
- `/live-queue` par doctor session status bhi realtime reflect ho sake

---

## Backend changes done

### 1) Authenticated socket connect par initial doctor session state

Ab default authenticated socket connection par server emit karta hai:

- `doctor.session.current`
- `doctor.session.updated`

Ye especially refresh/reconnect case ke liye add kiya gaya hai.

### 2) `/live-queue` namespace par doctor session realtime update

Ab affected `/live-queue` rooms me backend emit karta hai:

- `doctor.session.updated`

Earlier `/live-queue` mainly `queue-updated` snapshot use karta tha.

### 3) Existing behavior still continues

Backend still emits:

- `doctor.session.updated` on default authenticated namespace
- `doctor.session.updated` on `/public-status`
- `queue-updated` on `/live-queue`

---

## Frontend impact

## A. Doctor dashboard

Doctor dashboard ko reconnect/refresh ke baad current status restore karne ke liye socket par ye events handle karne chahiye:

- `doctor.session.current`
- `doctor.session.updated`

### Expected use

If payload says:

```json
{
  "is_doctor_available": true,
  "status": "IN",
  "label": "Doctor In"
}
```

then UI should show:

- doctor active state
- pause / "Not at my desk" type action
- **not** the default "Start Session" state

If payload says:

```json
{
  "is_doctor_available": false,
  "status": "OUT",
  "label": "Doctor Out"
}
```

then UI should show:

- "Start Session"

---

## B. `/live-queue` page

`/live-queue` frontend should now listen to:

- `queue-updated`
- `doctor.session.updated`

### Recommended handling

- `queue-updated` → queue snapshot refresh / token board update
- `doctor.session.updated` → doctor availability badge/banner/button state update

If frontend already derives everything from `queue-updated`, that can continue.
But if explicit doctor availability UI dikhani hai, `doctor.session.updated` handle karna better hai.

---

## Namespaces and events

### 1) Default authenticated namespace

Events:

- `doctor.session.current`
- `doctor.session.updated`

Use for:

- doctor dashboard
- receptionist / medical / authenticated role dashboards

### 2) `/public-status`

Events:

- `doctor.session.current`
- `doctor.session.updated`

Use for:

- public doctor availability display

Optional handshake query supported:

- `doctor_id`
- `branch_id`

### 3) `/live-queue`

Events:

- `queue-updated`
- `doctor.session.updated`

Use for:

- queue board
- now serving display
- doctor availability state on queue display

---

## Recommended frontend listener example

```js
socket.on("doctor.session.current", (payload) => {
  setDoctorSession(payload);
});

socket.on("doctor.session.updated", (payload) => {
  setDoctorSession(payload);
});

socket.on("queue-updated", (payload) => {
  setQueueSnapshot(payload);
});
```

---

## Recommended frontend state fields

Frontend should safely use:

- `is_doctor_available`
- `status`
- `label`
- `started_at`
- `ended_at`
- `doctor_name`
- `branch_name`
- `doctor_id`
- `branch_id`
- `session_id`
- `updated_at`

---

## Manual test checklist

## Doctor dashboard

1. Login as doctor
2. Open dashboard
3. Click `Start Session`
4. Confirm UI changes to active state
5. Refresh page
6. Confirm UI still shows active session, not default start button
7. Click `Not at my desk` / pause
8. Refresh again
9. Confirm UI shows `Start Session`

## `/live-queue`

1. Open `/live-queue` page subscribed to correct room
2. Start doctor session from doctor dashboard
3. Confirm `doctor.session.updated` or derived queue UI updates in real time
4. Pause doctor session
5. Confirm status changes in real time without page reload

## Cross-role dashboard

1. Open doctor dashboard in one tab
2. Open receptionist/medical/other affected dashboard in another tab
3. Start/pause doctor session
4. Confirm other page receives updated doctor status live

---

## Important note

If frontend still shows wrong button after these backend changes, then remaining issue will most likely be frontend-side:

- listener missing
- listener attached to wrong namespace
- reconnect flow not restoring state
- payload received but local UI state not updated

