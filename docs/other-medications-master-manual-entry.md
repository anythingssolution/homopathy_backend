# Other Medications — Save Manual Doctor Entries To Master Dropdown

## Previous behavior

Dropdown medicines and **Manual doctor entry** used **different storage**:

| Source | Table used |
|--------|------------|
| Dropdown list | `master_text_medicines` (variants from `master_medical_products`) |
| Manual doctor entry | **Only** `tbl_consultation_medications` (`is_manual_entry = 1`) |

Manual names were **not** added to the dropdown master, so they did not appear next visit. Quantity / Variant was also disabled for manual rows because no product variants existed.

## What changed

Manual doctor entries now save into the **same dropdown table**, with a flag to identify them.

### `master_text_medicines`

| Column | Meaning |
|--------|---------|
| `is_doctor_manual` | `1` = doctor typed this medicine; `0` = catalog / imported |

### `master_medical_products`

Custom Quantity / Variant for a manual (or typed) variant is stored as:

- `source_type = 'DOCTOR_MANUAL'`
- `packing` = variant label (e.g. `100ml`, `200ml`)
- `medicine_text_id` = the master medicine row

### Consultation row (unchanged)

`tbl_consultation_medications.is_manual_entry` still marks that **this visit** used a doctor-typed medicine.

## UI

- Manual medicines show **Manual doctor entry** on the form.
- Dropdown labels for doctor-added medicines show `(Manual)`.
- Quantity / Variant is enabled for manual rows: doctor can **select or type** a variant (e.g. `100ml`) and set Qty.
- Use **+** on a row to add another variant of the **same medicine** (e.g. syrup `2ml` and `10ml`).
  - One medicine name in `master_text_medicines`
  - One `master_medical_products` row per variant
  - One consultation line per variant
- After save, that medicine + variant appear in the dropdown on later consultations.

## Migration

`sql/migrations/2026-08-14_001_master_text_medicines_doctor_manual.sql`

## How to identify

```sql
-- Doctor-added medicines in the dropdown master
SELECT id, medicine_value, is_doctor_manual
FROM master_text_medicines
WHERE is_doctor_manual = 1;

-- Doctor-added variants
SELECT id, product_name, packing, mrp_rate, source_type
FROM master_medical_products
WHERE source_type = 'DOCTOR_MANUAL';
```
