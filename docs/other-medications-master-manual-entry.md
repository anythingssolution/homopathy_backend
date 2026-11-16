# Other Medications — Save Manual Doctor Entries To Master Dropdown

## Current catalog rule — 16 November 2026

This supersedes the older behavior where a doctor-added name or historical manual
variant could appear without an active Product Master entry.

- Saving a new manual name now also creates its `master_medical_products` row.
  Missing packing is stored as `N/A`; missing price stays `NULL` and the existing
  Product Master UI displays `-`. No guessed rate or forced free price is added.
- Consult dropdown names require an active linked product, including doctor-added
  names. Historical pricing may enrich an existing active variant, but never adds
  an unlisted/deleted variant back to the options.
- Existing Delete remains a soft delete. Removing a packing hides that packing;
  removing the final active product hides the medicine name on the next dropdown
  fetch. Already-open consult forms need to be reopened/refreshed to reload masters.
- A stale manual save does not reactivate a deleted product or create a replacement
  when all its existing products are inactive. Restore through Product Master.
- Product Master's Source Type filter includes `Doctor Manual`.
- Existing name spelling/spacing differences remain separate. No products are
  merged; saved prescriptions, pricing rows and bills are unchanged.

### Live database update

Run the **complete** manual SQL file in the selected clinic database:

`sql/2026-11-16_sync_manual_medicines_product_master.sql`

1. Run the SQL before deploying the matching backend/frontend. It first lists
   candidate names, inserts missing product rows, reports the inserted count and
   verifies the remaining missing count (expected zero).
2. Upload the code and reopen the consultation/Product Master screens.
3. If new name-only entries were added with the old code between SQL and deployment,
   run the same SQL again. It skips existing products, including inactive/deleted
   ones, and never overwrites their rates, IDs or status.

The repair is intentionally outside `sql/migrations`: it is run manually by the
operator, does not run at startup and does not edit `schema_migrations`. It adds no
columns/tables and contains no environment-specific IDs. Keep the existing unique
indexes in place. A fresh read-only local preview found **84** candidates; the live
count may differ.

Compatibility review: the INSERT uses a direct LEFT JOIN to its target, not a
target-table subquery, following the
[MySQL INSERT ... SELECT restrictions](https://dev.mysql.com/doc/refman/8.0/en/insert-select.html).
It uses no engine-specific conditional ALTER syntax or regular-expression functions.
Local validation covers MariaDB 12.1.2: read-only EXPLAIN against the real schema,
plus an isolated temporary-table/snapshot exercise for first run, rerun, deletion
and preserved rates. The snapshot avoids MySQL's restriction on reading a temporary
insert target twice. Execution on the live MySQL server has **not** been performed.
Clinic data was not repaired or changed during this work.

Regression command (writes only connection-local synthetic tables):

```sh
RUN_MANUAL_CATALOG_DB_TEST=1 node --test test/manualMedicineCatalog.test.js test/textMedicineRemark.test.js
```

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
