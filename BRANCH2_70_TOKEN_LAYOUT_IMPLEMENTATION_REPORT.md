# Branch 2 70 Token Layout Implementation Report

## Goal

Branch `2` (Pandri / Devendra Nagar) now supports a 70-token base OPD plate while branch `1` continues to use the existing 40-token plate. The UI layout remains the same; token counts, category rules, and per-token durations are branch-aware and DB-defined.

## Branch Rules

Branch `1` remains unchanged:

- Acute Treatment: 5 tokens
- First Consultation: 6 tokens
- Chronic Case Discussion: 1 token
- Follow-up Visit: 28 tokens
- Total: 40 tokens

Branch `1` follow-up durations:

- First 9 follow-up tokens in the saved token order: 5 minutes
- Remaining 19 follow-up tokens: 4 minutes

Branch `2` uses:

- Acute Treatment: 8 tokens
- First Consultation: 13 tokens
- Chronic Case Discussion: 0 tokens
- Follow-up Visit: 49 tokens
- Total: 70 tokens

Branch `2` follow-up durations:

- 18 follow-up tokens: 5 minutes
- 31 follow-up tokens: 4 minutes

`master_treatments.estimated_duration_minutes` remains fallback/reference data. The actual base plate timing now comes from `tbl_branch_token_layouts.duration_minutes` when it is present.

## Files Changed

- `utils/appointmentTokens.js`
  - Added branch-aware token rules.
  - Added `getBranchMaxTokenNumber` and `getBranchTokenPlateRules`.
  - Updated layout validation to support branch `1` and branch `2`.
  - Updated next-token assignment so branch `2` can allocate tokens beyond 40.
  - Made token timing read `duration_minutes` from branch token layout rows before falling back to generated rule durations.

- `controllers/v1/appointmentController.js`
  - Appointment form token range now uses branch-aware max token count when a branch filter is present.

- `controllers/v1/receptionistController.js`
  - Receptionist form token range now uses branch-aware max token count.
  - Token layout fetch returns `token_count`, `token_rules`, and per-token `duration_minutes`.
  - Token layout save validation is branch-aware.
  - Token layout save preserves `duration_minutes`.
  - Re-approval token reassignment uses branch max count.

- `sql/2026-06-17_branch2_70_token_layout.sql`
  - Seeds branch `2` token positions:
    - Acute: 5, 10, 15, 20, 25, 30, 35, 40
    - First Consultation: 6, 11, 16, 21, 26, 31, 36, 41, 46, 51, 56, 61, 66
    - Follow-up: all remaining tokens

- `sql/2026-06-17_branch_token_duration_overrides.sql`
  - Adds `tbl_branch_token_layouts.duration_minutes`.
  - Sets branch `1` follow-up durations to 9 tokens at 5 minutes and 19 tokens at 4 minutes.
  - Sets branch `2` follow-up durations to 18 tokens at 5 minutes and 31 tokens at 4 minutes.

- Frontend:
  - `src/components/dashboard/TokenLayoutManager.tsx`
    - Keeps the same UI and drag/drop behavior.
    - Reads token count and rule counts from the API.
    - Preserves per-token duration data when saving a layout.
    - Branch `1` still shows 40-token rules.
    - Branch `2` shows 70-token rules.
  - `src/components/dashboard/ExtraSlotTokenManager.tsx`
    - The base-token label now uses preview data instead of hardcoded 40.

## Database Status

The branch `2` seed was applied locally.

Verified counts:

- Branch `1`: 40 rows
- Branch `2`: 70 rows

Branch `2` counts:

- Acute Treatment: 8
- First Consultation: 13
- Follow-up Visit: 49

Duration counts:

- Branch `1` Follow-up Visit: 9 at 5 minutes, 19 at 4 minutes
- Branch `2` Follow-up Visit: 18 at 5 minutes, 31 at 4 minutes

## Runtime Verification

Branch `1` generator:

- Token count: 40
- Token 13: Follow-up Visit, `12:04` to `12:09`, 5 minutes
- Token 14: Follow-up Visit, `12:09` to `12:13`, 4 minutes
- Last token: token 40, Chronic Case Discussion, `14:11` to `14:25`

Branch `2` generator:

- Token count: 70
- Token 1: Follow-up Visit, `11:30` to `11:35`, 5 minutes
- Token 70: Follow-up Visit, `17:26` to `17:30`, 4 minutes

Extra-hour append for branch `2`:

- Base token count: 70
- Next extra range: 71 to 82
- First extra token starts at `17:30:00`
- Extra block duration: 60 minutes

## Smoke Tests

Backend unit tests:

- `npm test` passed.

Frontend type/lint:

- `npm run lint` passed.

Rollback insert smoke:

- Patient self booking, branch `2`, token 70: insert succeeded and rolled back.
- Receptionist booking, branch `2`, token 66: insert succeeded and rolled back.
- Branch `1` follow-up token 13: insert succeeded with 5-minute duration and rolled back.
- Branch `1` follow-up token 14: insert succeeded with 4-minute duration and rolled back.
- Verified no `SMOKE%` appointment rows remained after rollback.

## Notes

- UI structure and workflow were intentionally kept unchanged.
- Branch `2` does not use Chronic Case Discussion tokens in the 70-token base plate.
- Existing one-hour append logic did not need structural changes; once branch `2` has a 70-token base plate, extra tokens begin after token 70 automatically.
