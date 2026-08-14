# Consultation — Repeat & Same Toggles + Extended Duration

## Summary

The consultation form now supports **Repeat** and **Same** flags (mutually exclusive), shows them on prescription print, and adds **extended medication duration** options beyond 7 / 15 / 30 days.

## What Changed

### Consultation Form (Frontend)

- **7 / 15 / 30 / 45 days:** Repeat and Same are mutually exclusive checkboxes.
- **2 / 3 / 6 months:** doctor splits months between Repeat and Same (both can be used). Example: 6 Mo → 4 Same + 2 Repeat, or 1 Same + 5 Repeat.
- Month splits are stored as `repeat_months` and `same_months`.
- `is_repeat` / `is_same` are still set when the matching months (or day toggle) are used.

### Prescription Print

When **Repeat** or **Same** is checked on save, it appears in the **vitals row** alongside fields like **MODE**, **B/P**, **SPO2**, etc.

| Flag | Print label (EN) | Print label (HI) | Value shown |
|------|------------------|------------------|-------------|
| Repeat | `REPEAT` | `दोहराएँ` | Visit date (`DD/MM/YYYY`) |
| Same | `SAME` | `समान` | Visit date (`DD/MM/YYYY`) |

- Updated in **Prescription Print** and **All Visits Print**.
- Layout matches existing clinical detail fields (e.g. MODE, CHIEF COMPLAINT, CLINICAL FINDINGS).

### Extended Duration Options

Duration pills on the consultation form:

| UI label | Stored days |
|----------|-------------|
| 7 | 7 |
| 15 | 15 |
| 30 | 30 |
| 45 | 45 |
| 2 Mo | 60 |
| 3 Mo | 90 |
| 6 Mo | 180 |

- Allowed backend values: `7, 15, 30, 45, 60, 90, 180`.
- **30-day frequency** sub-options (2× / 3× per day) still appear when duration is **30 days**.
- Formula pricing scales by duration multiplier:

| Days | Multiplier |
|------|------------|
| 7 | 1× |
| 15 | 2× |
| 30 | 4× |
| 45 | 6× |
| 60 (2 Mo) | 8× |
| 90 (3 Mo) | 12× |
| 180 (6 Mo) | 24× |

### Database

Migration: `sql/migrations/2026-08-13_005_consultation_repeat_same_duration.sql`

| Column | Type | Purpose |
|--------|------|---------|
| `is_repeat` | `TINYINT(1) DEFAULT 0` | `1` when Repeat is checked |
| `is_same` | `TINYINT(1) DEFAULT 0` | `1` when Same is checked |
| `medication_duration_days` | `SMALLINT UNSIGNED` | Expanded to allow up to 180 days |

Notes:

- `is_repeat` and `is_same` cannot both be `1` (validated in backend).
- Old duration check constraint (`7, 15, 30` only) is removed via column type update.

### API Payload

Consultation save (`POST /api/v1/doctors/consultations`):

```json
{
  "appointment_id": 123,
  "symptoms": "Chief complaint text",
  "medication_duration_days": 60,
  "is_repeat": true,
  "is_same": false,
  "medications": []
}
```

Validation rules:

- `medication_duration_days` must be one of: `7, 15, 30, 45, 60, 90, 180`
- `is_repeat` and `is_same` cannot both be `true`

Consultation response includes:

```json
{
  "is_repeat": true,
  "is_same": false,
  "medication_duration_days": 60
}
```

### Files Touched

| Area | File |
|------|------|
| Duration helpers | `homopathy_frontend/src/utils/medicationDuration.ts` |
| Consultation UI | `homopathy_frontend/src/components/dashboard/ConsultationPage.tsx` |
| Draft storage | `homopathy_frontend/src/utils/consultDraftStorage.ts` |
| Prescription print | `homopathy_frontend/src/components/PrescriptionPrint.tsx` |
| All visits print | `homopathy_frontend/src/components/AllVisitsPrint.tsx` |
| Payload validation | `homopathy_backend/controllers/v1/doctor/shared.js` |
| Consultation save | `homopathy_backend/controllers/v1/doctor/consultationController.js` |
| Migration | `homopathy_backend/sql/migrations/2026-08-13_005_consultation_repeat_same_duration.sql` |

## How To Test

1. Open a consultation for a patient.
2. Toggle **Repeat** or **Same** (confirm only one can be active at a time).
3. Select a new duration such as **45** or **2 Mo**.
4. Save the consultation.
5. Print the prescription.
6. Confirm **REPEAT** or **SAME** appears in the vitals/clinical details row with the visit date.
7. Confirm duration-based pricing reflects the selected period (e.g. 2 Mo → 8× base amount).

## SQL Examples

Find consultations marked as Repeat or Same:

```sql
SELECT
  id,
  appointment_id,
  medication_duration_days,
  is_repeat,
  is_same,
  created_at
FROM tbl_consultations
WHERE is_repeat = 1 OR is_same = 1
ORDER BY created_at DESC;
```

Find consultations using extended durations:

```sql
SELECT
  id,
  appointment_id,
  medication_duration_days
FROM tbl_consultations
WHERE medication_duration_days IN (45, 60, 90, 180);
```

## Notes

- **Repeat** is separate from **Repeat Previous Treatment** (follow-up draft loader). The toggle is a consultation label for print/reporting.
- Repeat/Same flags are optional and default to `false`.
