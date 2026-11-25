# Manual medicine catalog persistence — 25 November 2026

This updates the save rule in `other-medications-master-manual-entry.md`: a TEXT
medicine marked `is_manual_entry` is checked even if `persist_manual_master` is
false after repeat, draft restoration, or variant selection. Explicit persistence
requests remain supported. No schema or endpoint changes are required.

`manualMedicineCatalogService` runs inside the existing consultation transaction.
It reuses active names/variants, inserts genuinely missing ones, and can link an
active unlinked matching product. Existing names, catalog prices and inactive
names/products/variants are preserved. A name row lock serializes variant creation
for that name. Existing database uniqueness remains in force. Saved consultation
amount, quantity, remarks, dosage and dispensing data retain their existing flow.

Doctor and medical already use the same text-medicine handler at their existing
authorized routes; no parallel role-specific catalog is introduced. Reopen the
form to fetch updated master options.

## Historical repair

`node scripts/repairManualMedicineCatalog.js` previews and rolls back by default.
`--commit` is restricted to a local database and takes a full SQL backup first.
It reads doctor-entered TEXT medicine rows from active completed appointments,
using the existing display parser to separate medicine, packing and quantity.
Only a consistent positive historical unit price is used. Conflicting/unknown
rates become NULL rather than a guessed rate. Existing rates are never replaced.
Only the two master tables are written. Existing table rows are compared before
commit; history, bills and pricing rows are not written.

The local repair added 20 names and 40 product variants. Seven new products had
conflicting historical prices and were left without a catalog rate. Eighteen
fully inactive-product candidates and 25 inactive variants were skipped. Counts
refer to name/variant candidates, not unique medicines. A second preview added
zero rows. Reports and backup are under
`master_prev_user_data/manual_catalog_repair_2026-11-25/` in the workspace root.

Production was not modified. This repair script does not run at startup. Its SQL
uses existing MySQL-compatible DML, not conditional DDL; integration tests used
local MariaDB and are not proof of execution on live MySQL.

## Verification

`RUN_MANUAL_CATALOG_DB_TEST=1 node --test test/manualMedicineCatalogPersistence.test.js test/manualMedicineCatalog.test.js test/textMedicineRemark.test.js`

The integration tests create connection-local synthetic tables which shadow the
master names and roll back, leaving real records untouched. They exercise false
frontend flags, duplicate resave, rate preservation, missing links, inactive
names, fully inactive products, an inactive variant alongside an active variant,
unknown price, and rollback. Full backend suite also passes. The actual shared
catalog handler and Product Master service returned repaired `7Q/15`, `20ml`,
unit price 100 against the local database. No real consultation was submitted
for testing.
