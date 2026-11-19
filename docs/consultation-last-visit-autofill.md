# Last visit auto-fill

Current implementation: 17 November 2026. This is independent of the manual Repeat Previous Treatment picker.

## Doctor workflow

Doctor Dashboard has an **Auto-fill last visit** switch above the appointment filters. Each doctor's setting is stored on their own `master_users` row and applies across their working branches. The initial value is OFF. Turning it ON affects newly opened editable consultations; turning it OFF does not erase an existing consultation draft.

On opening an editable consult with ON enabled, the server finds the most recent active, completed consultation for the exact patient account and family-member identity. SELF only matches SELF. There is no historical branch, doctor, treatment type or follow-up-chain filter, and a completed visit without a prescription can also be the source. Future visits and the current appointment are excluded. Duplicate family-member identities are not silently merged.

The selected source's date and branch appear above the form. The doctor reviews and edits the copied data, then uses the existing Confirm & Complete action. Auto-fill itself does not save a completed consultation, advance the queue, collect payment, or create a bill.

## Copied fields and ownership

- Complaints, clinical findings, diagnosis, medication duration, numeric medicines and saved doses, text medicines, quantities, instructions and medicine amounts.
- Follow-up interval (including a custom interval), Repeat/Same selections, consultation mode, and no-prescription mode.
- Vitals; current booking vitals take priority if already recorded.
- Extended patient history, lifestyle answers and parent-history details, examinations, mental status, disease and universal remarks.
- Active advised tests as new test rows. Old test-result ownership and interpretation IDs are not copied to the new order.
- Investigation details as new rows, without the old investigation IDs or attachment ownership. Existing current-booking investigations take priority. Old attachments remain accessible on their original record.

Medical staff's later additions and voided prescription/test rows are not reissued as the doctor's treatment. Patient identity, current booking, reception/payment/dispensing status, bill links and case closure are not copied. The follow-up-only `repeated_from_consultation_id` is not set by auto-fill, so first-consultation and acute-treatment appointments can use the feature too.

## Draft and request safety

A meaningful saved draft wins over history. A blank draft automatically stored merely by opening the page does not block auto-fill. Typing or selecting controls while history is loading prevents the response from replacing the doctor's work. Requests cancel on route/context changes, and a previous patient's fields cannot be persisted under the next appointment. Completion is disabled during the history request. A request failure leaves manual entry available.

Copied quick-formula text is not automatically reparsed against a different current Formula Master version: the saved doses remain intact until the doctor edits/parses the formula. Existing manual Repeat behavior is retained.

## API and database

- `GET /api/v1/doctors/consultation-preferences`
- `PUT /api/v1/doctors/consultation-preferences`, body `{ "autofill_last_visit": true }` or false
- `GET /api/v1/doctors/consultations/:appointment_id/last-visit-prefill`

All endpoints require authenticated doctor access. Access to the current booking retains the existing working-branch and appointment authorization; only the historical lookup spans branches. An OFF setting prevents the history lookup.

Migration: `sql/migrations/2026-11-16_002_doctor_consultation_autofill.sql`. It adds `master_users.consultation_autofill_enabled TINYINT(1) NOT NULL DEFAULT 0`. It uses metadata-driven prepared DDL compatible with MySQL/MariaDB syntax and is safe to retry without resetting existing choices. Run the managed migration runner (`npm run migrate`) during deployment; the standard `npm start` also runs managed migrations. Do not edit existing migration checksums/history. Before migration, the switch reports setup pending and existing consultation entry remains usable.

## Verification

- Backend suite: 383 passed, 11 skipped, no failures at implementation verification; includes 7 preference/source/controller/route tests.
- Frontend mapper/draft checks: 5 passed. TypeScript and production web/TV builds passed.
- Isolated MariaDB 12.1.2 fixture: first apply, raw DDL retry, managed rerun, per-doctor preference isolation, user-row preservation, exact SELF/family matching and cross-branch lookup passed. This is not live MySQL verification.
- Local migration applied through the managed runner: 1 new migration applied; 38 previously applied migrations preserved.
- Local browser: ON and OFF survive reload; ON fills an editable consultation and displays source date/branch; reopening preserves its saved draft even with OFF selected. No consultation was completed/submitted during verification.
- Live deployment and live MySQL verification were not performed.
