# Frontend Appointment Reports Guide

Ye document frontend ko appointment reports API consume karne ke liye hai.

## API

```http
GET /api/v1/reports/appointments?from=YYYY-MM-DD&to=YYYY-MM-DD
```

Example:

```http
GET /api/v1/reports/appointments?from=2026-06-22&to=2026-06-22
```

Date range example:

```http
GET /api/v1/reports/appointments?from=2026-06-01&to=2026-06-22
```

## Required headers

```http
Authorization: Bearer <token>
```

## Required query filters

| Filter | Required | Format | Notes |
| --- | --- | --- | --- |
| `from` | Yes | `YYYY-MM-DD` | Start date |
| `to` | Yes | `YYYY-MM-DD` | End date |

Frontend initial load me current date ko dono filter me bheje:

```ts
const today = new Date().toISOString().slice(0, 10);
const params = new URLSearchParams({
  from: today,
  to: today,
});
```

## Role and branch behavior

- Doctor aur reception module access wale users API use kar sakte hain.
- Branch-scoped user ke liye selected branch automatically apply hoti hai.
- Frontend ko usually `branch_id` bhejne ki zarurat nahi hai agar branch selection gate already selected branch set kar raha hai.

## Response shape

```json
{
  "success": true,
  "message": "Appointment reports fetched successfully",
  "data": {
    "date_wise_appointments": [],
    "branch_wise_appointments": [],
    "slot_wise_appointments": [],
    "treatment_wise_appointments": [],
    "status_appointments": [],
    "reception_status_appointments": [],
    "booking_source_appointments": [],
    "booking_subject_appointments": []
  },
  "meta": {
    "filters": {
      "from": "2026-06-01",
      "to": "2026-06-22",
      "branch_id": 1
    },
    "report_keys": [
      "date_wise_appointments",
      "branch_wise_appointments",
      "slot_wise_appointments",
      "treatment_wise_appointments",
      "status_appointments",
      "reception_status_appointments",
      "booking_source_appointments",
      "booking_subject_appointments"
    ]
  }
}
```

## Report sections

### 1) Date-wise appointment count

Key:

```ts
data.date_wise_appointments
```

Row shape:

```json
{
  "appointment_date": "2026-06-22",
  "total_appointments": 42,
  "pending_appointments": 10,
  "confirmed_appointments": 0,
  "completed_appointments": 30,
  "cancelled_appointments": 2
}
```

Use for daily trend table/chart.

### 2) Branch-wise appointments

Key:

```ts
data.branch_wise_appointments
```

Row shape:

```json
{
  "branch_id": 1,
  "branch_name": "Lily Chowk Branch",
  "total_appointments": 50,
  "pending_appointments": 12,
  "confirmed_appointments": 0,
  "completed_appointments": 35,
  "cancelled_appointments": 3
}
```

Use for branch comparison.

### 3) Slot-wise appointments

Key:

```ts
data.slot_wise_appointments
```

Row shape:

```json
{
  "slot_id": 1,
  "slot_name": "Morning",
  "branch_id": 1,
  "branch_name": "Lily Chowk Branch",
  "start_time": "08:00:00",
  "end_time": "12:00:00",
  "total_appointments": 25,
  "pending_appointments": 5,
  "confirmed_appointments": 0,
  "completed_appointments": 19,
  "cancelled_appointments": 1
}
```

Use for slot load comparison.

### 4) Treatment-wise appointments

Key:

```ts
data.treatment_wise_appointments
```

Row shape:

```json
{
  "treatment_id": 1,
  "treatment_name": "New Case",
  "total_appointments": 20,
  "pending_appointments": 4,
  "confirmed_appointments": 0,
  "completed_appointments": 15,
  "cancelled_appointments": 1
}
```

Use for treatment demand report.

### 5) Pending/Confirmed/Completed/Cancelled status report

Key:

```ts
data.status_appointments
```

Row shape:

```json
{
  "status": "Completed",
  "total_appointments": 120
}
```

Use for status summary cards or pie chart.

### 6) Reception approval/rejection report

Key:

```ts
data.reception_status_appointments
```

Row shape:

```json
{
  "reception_status": "APPROVED_BY_RECEPTION",
  "total_appointments": 100
}
```

Possible values:

- `PENDING_AT_RECEPTION`
- `APPROVED_BY_RECEPTION`
- `REJECTED_BY_RECEPTION`

Use for reception workflow summary.

### 7) Self vs receptionist booking report

Key:

```ts
data.booking_source_appointments
```

Row shape:

```json
{
  "booked_by_type": "RECEPTIONIST",
  "total_appointments": 80
}
```

Possible values:

- `SELF`
- `RECEPTIONIST`

Use for booking source comparison.

### 8) Self vs family-member booking report

Key:

```ts
data.booking_subject_appointments
```

Row shape:

```json
{
  "booked_for_type": "FAMILY_MEMBER",
  "total_appointments": 15
}
```

Possible values:

- `SELF`
- `FAMILY_MEMBER`

Use for patient/family booking split.

## Frontend fetch example

```ts
type AppointmentReportsFilters = {
  from: string;
  to: string;
};

export async function fetchAppointmentReports(
  token: string,
  filters: AppointmentReportsFilters
) {
  const params = new URLSearchParams({
    from: filters.from,
    to: filters.to,
  });

  const response = await fetch(`/api/v1/reports/appointments?${params.toString()}`, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  const payload = await response.json();

  if (!response.ok || !payload.success) {
    throw new Error(payload.message || "Failed to fetch appointment reports");
  }

  return payload.data;
}
```

## Suggested UI state

```ts
const today = new Date().toISOString().slice(0, 10);

const [filters, setFilters] = useState({
  from: today,
  to: today,
});

const [reports, setReports] = useState(null);
const [isLoading, setIsLoading] = useState(false);
const [error, setError] = useState<string | null>(null);
```

## Error handling

Common backend validation errors:

```json
{
  "success": false,
  "message": "from and to are required in YYYY-MM-DD format"
}
```

```json
{
  "success": false,
  "message": "from must be less than or equal to to"
}
```

Frontend should show backend `message` directly.

## Notes for frontend

- All counts are returned as MySQL aggregate values, so frontend can convert with `Number(value || 0)` before charting.
- Keep date filter mandatory in UI.
- Initial screen should send today's date as `from` and `to`.
- For custom date range, call the same API again with selected `from` and `to`.
