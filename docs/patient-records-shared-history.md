# Shared patient history and family-member duplicate checks

Updated 14 November 2026. This replaces the selected-branch-only history behavior described in the 9 October workflow audit for the read paths below.

## Patient Records

- The Patient Records screen defaults to **All branches** and offers a separate history-branch filter. It does not change the staff user's working branch.
- Authenticated doctor, reception and medical users retain their existing module authorization. The standalone clinic's read-only registry, patient detail, visits and prescription timeline accept `branch_id=all`, or a positive branch ID for a single-branch view. Omitting the parameter retains the previous selected-branch default for existing callers.
- Registry visit counts/search, family-member counts, visit history and View/Print use the same history-branch scope.
- Clinical rows still require active completed appointments. Active standalone medication bills remain medicine-collection records. Self/family ownership and exact member-ID filters remain enforced.
- A valid active patient with no matching history returns an empty list, not a missing-patient error. Unknown patients and family IDs belonging to another account remain rejected.
- Single-visit prescription previews reuse the shared prescription timeline, so cross-branch views do not depend on operational medical/reception endpoints.
- Operational booking, queue, billing, dispensing and document mutations/downloads retain their working-branch restrictions.

## New family members

- Both patient and reception creation paths lock the primary account before checking existing family members and inserting. Existing-member appointment selection continues to reuse the existing ID.
- Name comparison ignores case, whitespace and punctuation, including Unicode names. Exact names and short/full-name variants in the same account warn even if age, DOB, gender or relationship differ. For example, `vedika` aged 26 still warns about existing `VEDIKA CHAWDA` records aged 11–12. Demographics are displayed for review; they do not suppress this warning. A genuinely different person can still be created through the explicit confirmation.
- A 409 `FAMILY_MEMBER_MATCH` response provides candidates with demographics, active state and last completed visit/branch. The UI offers **Use existing member** or an explicit **different person** confirmation.
- Different-person confirmation is signed, expires after ten minutes, and is bound to the account, submitted demographics and current candidates. A form change, concurrent insert or replay after creation requires review again. Confirmation does not bypass the five-active-member limit.
- No old member, appointment, prescription or bill is merged, deleted or reassigned. No schema migration is required.
