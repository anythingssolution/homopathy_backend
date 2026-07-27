# **Example for a token system work**



## Realtime Token Shift and Hold Rules

## Why this doc

This document converts the clinic requirement into a clear runtime rule-set for shifted doctor session timing, hold tokens, and slot reassignment.

---

## Base input

- Planned slot window: `6:00 PM` to `9:30 PM`
- Token sequence: `[1, 2, 3, 4, 12, 19, 20, 21, 22, 34]`
- Doctor actual session start: `6:20 PM`
- Required behavior: all token slot times must shift according to the new doctor start time

---

## Timing model

### Assumption

Because `10` tokens are distributed across `3 hours 30 minutes`, the working slot interval is treated as:

- `210 minutes / 10 tokens = 21 minutes per token`

So the whole queue shifts by `+20 minutes` from the original `6:00 PM` start.

### Shifted slot table

| Token | Shifted slot time |
| --- | --- |
| 1 | 6:20 PM |
| 2 | 6:41 PM |
| 3 | 7:02 PM |
| 4 | 7:23 PM |
| 12 | 7:44 PM |
| 19 | 8:05 PM |
| 20 | 8:26 PM |
| 21 | 8:47 PM |
| 22 | 9:08 PM |
| 34 | 9:29 PM |

---

## Core realtime rules

### Initial arrival state

- Token `1` is not in clinic
- Token `2` is not in clinic
- Tokens `3`, `4`, and `12` are in clinic and should be served in their shifted order

### Hold logic

- If a token is not physically available when its shifted slot time is reached, mark that token as `HOLD`
- `HOLD` means the token stays pending for later reassignment
- Hold priority should follow earliest skipped token first

Example hold priority after first two misses:

- Hold queue: `[1, 2]`

### Reassignment rule at token `19` slot

When the shifted slot for token `19` is reached:

- If token `19` is **not present on time**:
- assign that slot to token `1`
- keep token `2` in `HOLD`
- keep token `19` in `HOLD`

- If token `19` **is present on time**:
- serve token `19` in its own slot
- keep token `1` in `HOLD`
- keep token `2` in `HOLD`

### Continuous realtime behavior

The same approach must continue for all later slots in realtime:

- scheduled token present → serve scheduled token
- scheduled token absent → move scheduled token to `HOLD`
- if current scheduled slot becomes available because the scheduled token is absent, assign the slot to the earliest eligible `HOLD` token that is physically present
- if no `HOLD` token is physically present, continue with the next valid live token

---

## Example A: token `19` is absent at its slot time

This example assumes token `1` has arrived before `8:05 PM`.

| Time | Scheduled token | Presence status | Action | Result |
| --- | --- | --- | --- | --- |
| 6:20 PM | 1 | Absent | Put on hold | `HOLD: [1]` |
| 6:41 PM | 2 | Absent | Put on hold | `HOLD: [1, 2]` |
| 7:02 PM | 3 | Present | Serve 3 | Completed |
| 7:23 PM | 4 | Present | Serve 4 | Completed |
| 7:44 PM | 12 | Present | Serve 12 | Completed |
| 8:05 PM | 19 | Absent | Move 19 to hold, assign token 1 | `HOLD: [2, 19]` |

Runtime outcome:

- token `1` consumes the slot originally assigned to `19`
- token `2` remains pending
- token `19` remains pending

---

## Example B: token `19` is present on time

| Time | Scheduled token | Presence status | Action | Result |
| --- | --- | --- | --- | --- |
| 6:20 PM | 1 | Absent | Put on hold | `HOLD: [1]` |
| 6:41 PM | 2 | Absent | Put on hold | `HOLD: [1, 2]` |
| 7:02 PM | 3 | Present | Serve 3 | Completed |
| 7:23 PM | 4 | Present | Serve 4 | Completed |
| 7:44 PM | 12 | Present | Serve 12 | Completed |
| 8:05 PM | 19 | Present | Serve 19 | `HOLD: [1, 2]` |

Runtime outcome:

- token `19` keeps its own slot
- token `1` and token `2` stay on hold

---

## Implementation-ready runtime rule

Use the following queue policy in live operation:

- Maintain:
- `scheduledQueue`
- `holdQueue`
- `presentTokens`
- On each shifted slot time:
- if scheduled token is present, serve it
- if scheduled token is absent, move it to `holdQueue`
- after that, if the slot is still free, assign it to the earliest token in `holdQueue` that is currently present
- Never drop a missed token; missed tokens remain in `holdQueue` until served or manually cancelled

Example policy expression:

```
slot_owner_present ? serve(slot_owner) : hold(slot_owner) + serve(first_present_hold_token_if_any)
```

---

## Final functional statement

The backend/frontend queue flow should support a delayed doctor start, automatic slot shifting, missed-token hold management, and real-time reassignment of vacant slots using earliest-held eligible tokens, while preserving the exact special behavior requested for tokens `1`, `2`, and `19`.
