# Reception appointment timing messages

After a successful manual date-specific timing shift or Reset in Doctor Portal, reception rows affected by that operation show a **Timing update** action. Click it to review the visiting patient, account contact (for family bookings), date, branch, token and previous/current planned time. **Open WhatsApp** opens a draft at the saved WhatsApp contact, or the registered mobile if no WhatsApp contact is set. Reception must press Send in WhatsApp. No Meta API/template configuration is needed for this manual action, and no delivered/sent status is claimed.

## Storage and workflow boundaries

- Reuses `tbl_doctor_slot_time_override_audit_logs.new_data_json.patient_timing_notice`; no new table, schema migration, or edits to existing migration checksums.
- Snapshot metadata is saved on the existing audit row inside the original timing transaction. A failed transaction leaves neither changed timing nor a partial notice. WhatsApp opening/network delivery happens separately in the browser.
- Adds only appointment IDs and saved old/new planned timestamps, plus old/new slot starts. No patient names or phone numbers are duplicated in audit JSON.
- Only eligible bookings present at the time of the change are included. Cancelled, rejected, completed and inactive records are excluded. New bookings after the shift do not inherit old notifications.
- Normal booking, treatment duration, token ordering, slot restrictions and timing guards are unchanged. Existing queue-updated events refresh the reception list.
- Preview and Open WhatsApp both fetch current branch-authorized details with `Cache-Control: no-store`. A changed timing/contact requires another review. A reschedule/transfer/re-plan whose current saved timestamp differs from the snapshot cannot share the stale time.
- No inferred historical patient time is used: where an old planned timestamp was absent, the message gives only the updated saved time.
- Applies to new manual shifts/resets after this release; existing historical audit rows are not backfilled. Weekly-rule management does not create these manual-change snapshots.

## Verification

Unit/controller tests cover eligible affected IDs, repeated shifts/resets, rollback, selected-branch scope, family account contacts, invalid numbers, unchanged timing and stale plans. The opt-in database integration test uses temporary tables on one connection and verifies permanent table counts remain unchanged:

    RUN_SLOT_NOTICE_DB_TEST=1 node --test test/slotTimingNotice.integration.test.js

The reception preview was checked with sample data at desktop and 393px mobile width, including the changed-draft guard. No real appointment timing was changed and no real WhatsApp message was sent during verification. Production MySQL deployment and actual WhatsApp delivery were not exercised.
