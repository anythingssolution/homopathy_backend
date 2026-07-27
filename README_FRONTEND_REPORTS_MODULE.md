# Frontend Reports Module Guide

Ye document frontend ko reports module consume karne ke liye hai.

## Common rules

All report APIs same filter format follow karti hain.

### Required headers

```http
Authorization: Bearer <token>
```

### Required query filters

| Filter | Required | Format | Notes |
| --- | --- | --- | --- |
| `from` | Yes | `YYYY-MM-DD` | Start date |
| `to` | Yes | `YYYY-MM-DD` | End date |

Initial load me current date ko dono filters me bheje:

```ts
const today = new Date().toISOString().slice(0, 10);

const params = new URLSearchParams({
  from: today,
  to: today,
});
```

### Common response shape

```json
{
  "success": true,
  "message": "Reports fetched successfully",
  "data": {},
  "meta": {
    "filters": {
      "from": "2026-06-01",
      "to": "2026-06-22",
      "branch_id": 1
    },
    "report_keys": []
  }
}
```

### Branch behavior

- Branch-scoped users ke liye selected branch automatically apply hoti hai.
- Frontend usually `branch_id` na bheje; selected branch gate already branch context set karta hai.

## APIs

### 1) Appointment Reports

```http
GET /api/v1/reports/appointments?from=YYYY-MM-DD&to=YYYY-MM-DD
```

Data keys:

```ts
data.date_wise_appointments
data.branch_wise_appointments
data.slot_wise_appointments
data.treatment_wise_appointments
data.status_appointments
data.reception_status_appointments
data.booking_source_appointments
data.booking_subject_appointments
```

### 2) Doctor/Clinical Reports

```http
GET /api/v1/reports/clinical?from=YYYY-MM-DD&to=YYYY-MM-DD
```

Data keys:

```ts
data.summary
data.consultation_history
data.treatment_duration
data.followup_due
data.repeat_treatment_chain
data.diagnosis_disease
data.consultation_workflow
```

Use:

- `summary`: physical/on-call split, unique primary patients, disease/diagnosis/vitals coverage.
- `consultation_history`: consultation list with patient, doctor, branch, treatment, diagnosis, workflow.
- `treatment_duration`: medication duration wise consultation count.
- `followup_due`: follow-up due list by due date range.
- `repeat_treatment_chain`: repeated/follow-up treatment chain rows.
- `diagnosis_disease`: disease/diagnosis wise count.
- `consultation_workflow`: finalized/sent-to-medical/processed workflow summary.

### 3) Patient Reports

```http
GET /api/v1/reports/patients?from=YYYY-MM-DD&to=YYYY-MM-DD
```

Data keys:

```ts
data.summary
data.patient_master_list
data.patient_appointment_history
data.new_vs_repeat_patient
data.family_member_patient
data.patient_update_audit_history
data.gender_age_group_patient
```

Use:

- `summary`: active/inactive primary patients, family-member coverage, average age, minor/adult/senior counts.
- `patient_master_list`: patients created in date range.
- `patient_appointment_history`: appointment history in date range.
- `new_vs_repeat_patient`: new/repeat split based on previous appointment.
- `family_member_patient`: family-member bookings.
- `patient_update_audit_history`: patient profile update audit.
- `gender_age_group_patient`: gender and age group summary.

### 4) Billing/Payment Reports

```http
GET /api/v1/reports/billing?from=YYYY-MM-DD&to=YYYY-MM-DD
```

Data keys:

```ts
data.total_revenue
data.consultation_bill
data.medication_bill
data.payment_status
data.pending_amount
data.payment_mode_collection
data.branch_wise_revenue
data.patient_billing_history
```

Use:

- `total_revenue`: all active bills. It also includes `paid_or_partial_bills`, `unpaid_bills`, and `unpaid_amount` for reconciliation.
- `consultation_bill`: consultation bill list.
- `medication_bill`: medication bill list.
- `payment_status`: paid/unpaid/partial summary.
- `pending_amount`: bills with pending amount.
- `payment_mode_collection`: cash/online collection summary for paid/partially-paid bills only. `CASH` and `ONLINE` rows are returned even when one mode has zero data, so the UI can render stable cards/tables. Its `total_payments` sum should match `total_revenue.paid_or_partial_bills`, and its `collected_amount` sum should match `total_revenue.paid_amount`. Unpaid bills are shown separately in `total_revenue.unpaid_bills`.
- `branch_wise_revenue`: revenue grouped by branch.
- `patient_billing_history`: patient-wise bill totals.

### 5) Medical/Dispensary Reports

```http
GET /api/v1/reports/medical?from=YYYY-MM-DD&to=YYYY-MM-DD
```

Data keys:

```ts
data.summary
data.date_wise_summary
data.ready_prescriptions
data.processed_prescriptions
data.medicine_pricing
data.lab_test_medicine_item
data.medical_processed_by_user
```

Use:

- `summary`: ready count, processed count, and total pricing amount.
- `date_wise_summary`: date-wise ready count, processed count, and pricing amount.
- `ready_prescriptions`: prescriptions ready for medical.
- `processed_prescriptions`: prescriptions processed by medical.
- `medicine_pricing`: prescription pricing records.
- `lab_test_medicine_item`: medicine/test item summary.
- `medical_processed_by_user`: processed prescription count by medical user.

## Frontend fetch helper

```ts
type ReportModule =
  | "appointments"
  | "clinical"
  | "patients"
  | "billing"
  | "medical";

type ReportFilters = {
  from: string;
  to: string;
};

export async function fetchReports(
  token: string,
  module: ReportModule,
  filters: ReportFilters
) {
  const params = new URLSearchParams({
    from: filters.from,
    to: filters.to,
  });

  const response = await fetch(`/api/v1/reports/${module}?${params.toString()}`, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  const payload = await response.json();

  if (!response.ok || !payload.success) {
    throw new Error(payload.message || "Failed to fetch reports");
  }

  return payload.data;
}
```

## Suggested UI state

```ts
const today = new Date().toISOString().slice(0, 10);

const [activeModule, setActiveModule] = useState<ReportModule>("appointments");
const [filters, setFilters] = useState({
  from: today,
  to: today,
});
const [reports, setReports] = useState<any>(null);
const [isLoading, setIsLoading] = useState(false);
const [error, setError] = useState<string | null>(null);
```

## Error handling

Backend validation errors:

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

Frontend should display backend `message` directly.

## Notes

- Counts and amounts can come as strings from MySQL aggregate functions. Before charting, use `Number(value || 0)`.
- Keep `from` and `to` mandatory in the UI.
- Initial screen should call one API with today's date as both `from` and `to`.
- Date semantics:
  - Appointment, clinical, patient appointment history, and medical reports mostly use appointment date.
  - Billing reports use bill date. `payment_mode_collection` is also scoped by bill date so it reconciles with `total_revenue.paid_amount`.
  - Patient master and audit reports use created/update audit date.
