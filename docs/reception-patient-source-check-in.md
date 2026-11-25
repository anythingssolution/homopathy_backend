# Reception patient source: current decision, 25 November 2026

Reception collects a missing patient source immediately after successful check-in, replacing the earlier mandatory prompt after reception booking. The existing patient self-booking question stays optional. Existing manual reception source review/correction remains available.

## Conditions and persistence

- Approval, collecting payment, and choosing “No, Later” do not trigger this question. Both the list Check-In action and post-payment Yes, Check-In use the existing common successful-check-in handler.
- A saved answer skips the prompt. SELF and each family member retain separate identities; a later visit to another branch does not ask the same person again.
- Reception must choose one of the existing seven categories. Other requires a trimmed 1–255 character detail. There is no Patient does not know option and no mandatory-prompt Skip action.
- Check-in commits first. Source API failure leaves check-in/payment/token/queue state intact and offers retry.
- Successful CHECKED_IN queue events carry `meta_json.patient_source_collection = 'CHECK_IN'`. The existing transaction saves this marker without another write or a dependency on the source table.
- `GET /api/v1/receptionist/check-in-discovery/pending` recovers the oldest unanswered marked check-in for the authenticated operator and selected branch. Only the latest CHECKED_IN event for a visit owns recovery. Undo check-in, cancellation and inactive appointments are excluded. Historical events without the marker are excluded.
- Booking operator and check-in operator may differ. Recovery uses the check-in operator; source read/write use the existing branch-authorized operational appointment endpoints.
- Dashboard mount, focus, and successful check-in refresh recovery. Changing the account or working branch unmounts the previous prompt and aborts its pending request.
- Existing `tbl_patient_discovery_sources` storage, first-answer protection, explicit corrections and report date/branch attribution are unchanged. Previously saved answers and timestamps are untouched.

## Compatibility and release

No database migration or new table is required for this timing change. The old booking-pending table is retained, new booking writes to it stop, and its legacy recovery endpoint returns null. Deploy frontend and backend together: an already-open old frontend may still show its old booking prompt until reloaded.

This decision supersedes earlier reception booking-time collection. The separate removal/conversion of NOT_KNOWN is a separate change and its SQL is not run by this implementation.

## Verification

- Backend suite: 403 passed, 15 environment-gated tests skipped, zero failures.
- Additional local MariaDB fixture integration passed with `RUN_RECEPTION_SOURCE_DB_TEST=1 DB_HOST=127.0.0.1 node --test test/receptionDiscoveryCheckIn.integration.test.js`. It exercises the actual pending query and source service against disposable prefixed tables, including different booking/check-in operators, branch scope, historical/malformed events, undo/cancel/inactive cases, first-answer protection, family separation and unchanged attendance rows. Fixtures are dropped after the test; real clinic rows are not changed. This is not a live production MySQL verification.
- Frontend TypeScript check, production web build and legacy TV build passed.
- Isolated browser verification of the real prompt component: seven choices, no Skip/Escape dismissal, Other detail required, existing answer auto-closes, failed save retries successfully, and Hindi copy. Browser requests were fixture responses; no real patient was checked in or charged.

Live production deployment and an actual patient check-in were not performed for this change.
