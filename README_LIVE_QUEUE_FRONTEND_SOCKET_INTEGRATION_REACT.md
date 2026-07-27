# Live Queue Frontend Socket Integration Guide for React

Ye document React frontend ke liye hai. Isme explain kiya gaya hai ki backend live queue module ke saath websocket aur API integration kaise karni hai.

## Purpose

React app me jaha bhi queue/token data live dikhana hai, waha frontend ka source of truth backend snapshot hona chahiye.

Important:

- `GET /api/v1/live-queue/current-date-tokens` **sirf active queue items** deta hai
- consulted/completed appointment realtime me list se hat jayegi
- frontend ko local business logic se remove/insert maintain nahi karna chahiye
- backend ka latest snapshot aate hi React state replace karni chahiye
- token display ke liye ab `display_token_display` preferred field hai
- live ordering ke liye `live_queue_position` / `ready_queue` use karo, `current_token_number` ko patient token mat samjho

## Backend Endpoints

### 1) Current Date Tokens List

```http
GET /api/v1/live-queue/current-date-tokens
```

Optional query params:

- `branch_id`
- `slot_id`
- `appointment_date`

Example:

```http
GET /api/v1/live-queue/current-date-tokens?branch_id=1&slot_id=3
```

### 2) Slot Live Queue Snapshot

```http
GET /api/v1/live-queue/:slot_id?branch_id=1&appointment_date=2026-05-14
```

### 3) Call Next Ready Token

```http
POST /api/v1/live-queue/:slot_id/call-next
Authorization: Bearer <DOCTOR_OR_RECEPTIONIST_TOKEN>
Content-Type: application/json
```

```json
{
  "branch_id": 1,
  "appointment_date": "2026-05-14"
}
```

## Socket Room Subscription

Frontend ko socket connect ke baad room subscribe karna hoga.

### Event to emit

```text
live-queue.subscribe
```

### Payload

```json
{
  "branch_id": 1,
  "slot_id": 3,
  "appointment_date": "2026-05-14"
}
```

### Unsubscribe

```text
live-queue.unsubscribe
```

## Realtime Events to Listen

React frontend ko ye events listen karne chahiye:

- `queue-updated`
- `doctor-session-started`
- `doctor-session-completed`
- `token-called`
- `consultation-started`
- `consultation-completed`
- `appointment-cancelled`
- `token-shifted`

## Best Frontend Rule

### Never patch manually if full snapshot available

Har important event ke baad backend latest queue snapshot bhejta hai.

React me:

- current state ko mutate mat karo
- guessed local remove/add/reorder logic mat lagao
- incoming payload ke `active_queue` ya `waiting_queue` se state replace karo

This is the safest rule.

## Frontend Changes Required

### 1. Token rendering

Old:

- token badge = `token_display` ya `current_token_display`

New recommended:

- patient-facing token badge = `display_token_display`
- internal/ops badge = `current_token_display`

### 2. Queue sections

UI ko ideally 4 sections me split karo:

- `current_running_token`
- `ready_queue`
- `called_queue`
- `not_arrived_queue`

### 3. Live ordering

Display order ke liye:

- primary = `live_queue_position`
- fallback = `current_token_number`

### 4. ETA source

Ready queue me:

- `live_estimated_start_at`
- `live_estimated_end_at`
- `live_estimated_wait_minutes`

Planned schedule ke liye:

- `planned_start_at`
- `planned_end_at`

### 5. Protected POST APIs

Ab ye POST APIs public call nahi karne:

- session start/end
- call next
- check-in
- call/start/complete
- skip/reassign

In sab me bearer token bhejna hoga.

---

# React Integration Pattern

## Suggested structure

- `src/services/liveQueueApi.ts`
- `src/services/liveQueueSocket.ts`
- `src/hooks/useLiveQueue.ts`
- `src/pages/LiveQueuePage.tsx`
- `src/pages/LedDisplayPage.tsx`

## 1) API service example

```ts
import axios from "axios";

export const fetchCurrentDateTokens = async (params: {
  branch_id?: number;
  slot_id?: number;
  appointment_date?: string;
}) => {
  const response = await axios.get("/api/v1/live-queue/current-date-tokens", {
    params,
  });
  return response.data;
};

export const fetchSlotLiveQueue = async ({
  slot_id,
  branch_id,
  appointment_date,
}: {
  slot_id: number;
  branch_id?: number;
  appointment_date?: string;
}) => {
  const response = await axios.get(`/api/v1/live-queue/${slot_id}`, {
    params: { branch_id, appointment_date },
  });
  return response.data;
};
```

## 2) Socket service example

```ts
import { io, Socket } from "socket.io-client";

let socket: Socket | null = null;

export const getLiveQueueSocket = () => {
  if (!socket) {
    socket = io("http://localhost:3000/live-queue", {
      transports: ["websocket"],
    });
  }
  return socket;
};
```

Note:

- read-only LED/public/live-queue pages ke liye `/live-queue` public namespace use karo
- mutation APIs ke liye HTTP bearer token alag se bhejna hoga

## 3) React hook example

```ts
import { useEffect, useMemo, useState } from "react";
import { fetchSlotLiveQueue } from "../services/liveQueueApi";
import { getLiveQueueSocket } from "../services/liveQueueSocket";

type UseLiveQueueParams = {
  branchId: number;
  slotId: number;
  appointmentDate: string;
};

export const useLiveQueue = ({
  branchId,
  slotId,
  appointmentDate,
}: UseLiveQueueParams) => {
  const [queueData, setQueueData] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;
    const socket = getLiveQueueSocket();

    const loadInitial = async () => {
      setLoading(true);
      const result = await fetchSlotLiveQueue({
        slot_id: slotId,
        branch_id: branchId,
        appointment_date: appointmentDate,
      });

      if (mounted) {
        setQueueData(result.data);
        setLoading(false);
      }
    };

    loadInitial();

    socket.emit("live-queue.subscribe", {
      branch_id: branchId,
      slot_id: slotId,
      appointment_date: appointmentDate,
    });

    const handleSnapshot = (payload: any) => {
      if (!mounted) return;
      setQueueData(payload);
    };

    socket.on("queue-updated", handleSnapshot);
    socket.on("consultation-completed", handleSnapshot);
    socket.on("consultation-started", handleSnapshot);
    socket.on("token-called", handleSnapshot);
    socket.on("token-shifted", handleSnapshot);
    socket.on("appointment-cancelled", handleSnapshot);
    socket.on("doctor-session-started", handleSnapshot);
    socket.on("doctor-session-completed", handleSnapshot);

    return () => {
      mounted = false;
      socket.emit("live-queue.unsubscribe", {
        branch_id: branchId,
        slot_id: slotId,
        appointment_date: appointmentDate,
      });

      socket.off("queue-updated", handleSnapshot);
      socket.off("consultation-completed", handleSnapshot);
      socket.off("consultation-started", handleSnapshot);
      socket.off("token-called", handleSnapshot);
      socket.off("token-shifted", handleSnapshot);
      socket.off("appointment-cancelled", handleSnapshot);
      socket.off("doctor-session-started", handleSnapshot);
      socket.off("doctor-session-completed", handleSnapshot);
    };
  }, [branchId, slotId, appointmentDate]);

  const activeQueue = useMemo(() => queueData?.active_queue || [], [queueData]);
  const readyQueue = useMemo(() => queueData?.ready_queue || [], [queueData]);
  const calledQueue = useMemo(() => queueData?.called_queue || [], [queueData]);
  const notArrivedQueue = useMemo(
    () => queueData?.not_arrived_queue || [],
    [queueData]
  );
  const currentRunningToken = useMemo(
    () => queueData?.current_running_token || null,
    [queueData]
  );

  return {
    queueData,
    activeQueue,
    readyQueue,
    calledQueue,
    notArrivedQueue,
    currentRunningToken,
    loading,
  };
};
```

---

# How consulted appointment disappears in React

## Backend side

Jab doctor consultation complete karta hai:

1. `queue_status = COMPLETED`
2. appointment active queue se remove ho jati hai

---

# Why backend change hua

Ye change isliye kiya gaya:

- patient ko same token identity dikh sake
- runtime queue re-ordering possible rahe
- existing backend skip/reassign flow break na ho
- ready aur not-arrived patients clearly separate ho sake
- doctor/receptionist “next ready patient” safely call kar saken
3. backend socket se updated snapshot emit karta hai

## React side

Hook ke `handleSnapshot(payload)` me:

```ts
setQueueData(payload);
```

Bas itna hi.

Kyuki backend ke `active_queue` aur `current-date-tokens` dono me completed token ab aayegi hi nahi, to UI se wo automatically hat jayegi.

## Important

Is removal ke liye ye mat karo:

- `setQueueData(prev => prev.filter(...))`
- `remove item manually by appointment_id`

Reason:

- queue shift
- token reassignment
- multiple concurrent updates

ye sab backend better handle karta hai.

---

# Recommended React screens

## 1) Live Queue Admin Screen

Show:

- current running token
- waiting queue
- token ETA
- patient details

Use:

- initial snapshot API
- websocket room updates

## 2) LED / TV Display Screen

Show:

- now serving
- next tokens
- wait estimation

Recommended:

- only display-safe fields render karo
- `patient_full_name` ki jagah token + masked name use kar sakte ho

## 3) Doctor Screen

Show:

- current patient
- next token
- queue count

## 4) Reception Screen

Show:

- checked-in
- waiting
- shifted tokens
- queue order

---

# Reconnect Strategy

Socket disconnect hone par:

1. socket reconnect hone do
2. room dubara subscribe karo
3. ek fresh API snapshot hit karo
4. React state replace karo

## Example rule

```ts
socket.on("connect", async () => {
  socket.emit("live-queue.subscribe", {
    branch_id: branchId,
    slot_id: slotId,
    appointment_date: appointmentDate,
  });

  const result = await fetchSlotLiveQueue({
    slot_id: slotId,
    branch_id: branchId,
    appointment_date: appointmentDate,
  });

  setQueueData(result.data);
});
```

---

# Recommended frontend state shape

```ts
type LiveQueueState = {
  branch_id: number;
  slot_id: number;
  appointment_date: string;
  queue_status: string;
  current_running_token: any | null;
  active_queue: any[];
  waiting_queue: any[];
  drift_minutes: number;
  totals: {
    active: number;
    booked: number;
    checked_in: number;
    waiting: number;
    in_progress: number;
  };
};
```

---

# Do / Don’t

## Do

- initial API load lo
- socket snapshot se React state replace karo
- reconnect pe resync karo
- completed token ko backend-filtered view pe depend karo

## Don’t

- local fake sorting mat chalao
- frontend me token reordering mat likho
- completed token ko manually remove mat karo if snapshot already available

---

# Final Rule

For React:

**Backend snapshot is source of truth.**

Doctor consult complete hote hi frontend me item gayab karne ka best tareeka:

- backend emits new snapshot
- React `setState(payload)`
- completed appointment auto disappear
