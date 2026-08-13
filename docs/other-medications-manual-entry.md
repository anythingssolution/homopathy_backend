# Other Medications — Manual Entry & Hindi Remarks

## Summary

Doctors can add **custom / syrup medications** even when the medicine is not in the master dropdown. Remarks are stored in **both languages**:

- `remark` → English (what the doctor typed/selected)
- `remark_hi` → Hindi translation (auto-generated)

`PrescriptionPrint` shows English when language is EN, and Hindi when language is HI.

## What Changed

### Consultation Form (Frontend)

- Medicine name supports searchable dropdown + custom typed entry.
- Manual (non-master) medicines are flagged as **Manual doctor entry**.
- Remark field keeps English text; a live Hindi preview is shown below.
- On save, both `remark` and `remark_hi` are sent.

Example:

| Doctor types / selects | `remark` (English) | `remark_hi` (Hindi) |
|------------------------|--------------------|---------------------|
| `20 drop for 3 times in a day` | `20 drop for 3 times in a day` | `20 ड्रॉप दिन में 3 बार` |
| `2 spoon` | `2 spoon` | `2 चम्मच` |
| `3 drop grm pani k sath ya fir dudh k sath` | same English text | `3 ड्रॉप ग्राम पानी के साथ या फिर दूध के साथ` |

### Prescription Print

| Language | Remark shown |
|----------|--------------|
| English (`en`) | `remark` |
| Hindi (`hi`) | `remark_hi` (fallback to `remark`) |

Styling for the remark line is the same in both languages.

### Database

Migrations:

- `2026-08-13_002_...` — added `is_manual_entry` (+ temporary `remark_hi`)
- `2026-08-13_003_...` — dropped `remark_hi` briefly
- `2026-08-13_004_...` — **restored `remark_hi`**

| Column | Type | Purpose |
|--------|------|---------|
| `remark` | `VARCHAR(255) NULL` | English remark |
| `remark_hi` | `VARCHAR(255) NULL` | Hindi remark |
| `is_manual_entry` | `TINYINT(1) DEFAULT 0` | `1` when doctor typed medicine manually |

### API Payload

```json
{
  "medicine_type": "TEXT",
  "medicine_value": "Custom Syrup X",
  "remark": "20 drop for 3 times in a day",
  "remark_hi": "20 ड्रॉप दिन में 3 बार",
  "is_manual_entry": true,
  "amount": 150
}
```

### Files Touched

| Area | File |
|------|------|
| Hindi translator | `homopathy_frontend/src/utils/remarkHindiTranslator.ts` |
| Consultation UI | `homopathy_frontend/src/components/dashboard/ConsultationPage.tsx` |
| Prescription print | `homopathy_frontend/src/components/PrescriptionPrint.tsx` |
| Payload validation | `homopathy_backend/controllers/v1/doctor/shared.js` |
| Consultation save | `homopathy_backend/controllers/v1/doctor/consultationController.js` |
| Migrations | `sql/migrations/2026-08-13_002/003/004_*.sql` |

## How To Identify Manual Entries

```sql
SELECT
  id,
  consultation_id,
  medicine_value,
  remark,
  remark_hi,
  is_manual_entry
FROM tbl_consultation_medications
WHERE medicine_type = 'TEXT'
  AND is_manual_entry = 1;
```

## Notes

- Works best for **common clinic remarks** (English + Hinglish), e.g.:
  - `20 drop for 3 times in a day`
  - `3 drop grm pani k sath ya fir dudh k sath`
  - `sone se phle 3 drop thande pani k sathe`
- It uses a **phrase/word dictionary**, not full AI translation.
- Unknown / rare words are left as typed (so they are not mangled).
- We can keep expanding the dictionary when doctors use new common phrases.
- If input is already Devanagari, it is kept as-is.
- Manual entries do not auto-create `master_text_medicines` rows.
