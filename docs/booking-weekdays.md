# Weekly booking switches

Doctor UI: existing `/doctor-leave-calendar` URL, now labelled Clinic Schedule.
Weekly Booking is a day-by-branch-slot checkbox matrix; Leave Calendar retains
its existing selected-branch component and APIs. No timing editor is added.

## Data and rollout

Apply managed migration `2026-10-17_001_booking_weekdays.sql` before serving the
new backend. It creates only `tbl_branch_slot_booking_weekdays`; it does not
alter appointments, patient data, slots, leaves or existing timing overrides.
An absent slot/day row means ON. All OFF is an explicit valid configuration.
New active slots retain the original ON default until configured by a doctor.
The migration uses common MySQL/MariaDB CREATE TABLE syntax and is retry-safe.
Local verification uses MariaDB 12.1.2; production MySQL execution is not claimed.
Keep the normal migration runner and its checksums/history intact.

## API and authorization

- Doctor-only GET/PUT `/api/v1/doctors/booking-weekdays`: accessible slots are
  resolved from active `tbl_user_branch_access` rows, not request branch IDs.
  These two routes intentionally precede the working-branch guard. Every other
  doctor route retains that guard.
- GET `/api/v1/public/booking-date-availability?date=YYYY-MM-DD`: per-branch,
  per-slot switches and leave closures; no patient data or token-capacity claims.
- Existing single-branch availability includes weekly closure and slot statuses.
- Patient/reception create, reception reschedule, and booking token-plate routes
  enforce the shared rule. Extra tokens do not bypass final booking validation.
- Existing queue operations, appointment transfer, check-in, consultation,
  prescriptions, bills and historical appointment reads are not filtered by it.

Save requires the complete accessible slot/day matrix, boolean flags and the
loaded revision. Invalid/duplicate/unauthorized/partial saves are rejected;
stale revisions return 409. All rows save in one transaction. Final booking
validation holds a shared master-slot lock; schedule save locks accessible slots
in ID order before reading/writing settings, including previously absent rows.

OFF prevents new bookings and rescheduling into the session. Already booked
appointments continue unchanged. ON does not override leave, full tokens,
past-time checks, follow-up eligibility or any other existing booking rules.

## Verification

- `npm test`
- `RUN_BOOKING_WEEKDAYS_DB_TEST=1 node --test test/bookingWeekdays.integration.test.js`
- Frontend `npx tsx --test src/utils/bookingWeekdays.test.ts`, `npx tsc --noEmit`, `npm run build`

The DB fixture uses connection-local TEMPORARY tables and explicitly asserts
that persistent weekday settings are unchanged after cleanup. Browser checks
cover save/reload, a temporarily disabled Pandri branch with its visible reason,
restoration to all ON, and the existing saved leave entry. No patient booking,
cancellation, bill or consultation is created by these browser checks.
