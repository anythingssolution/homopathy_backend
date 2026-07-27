# Staff Branch Selection Frontend Handoff

This flow applies only to these authenticated staff roles:

- `doctor`
- `receptionist`
- `medical`

Patients are not forced into this branch-selection flow.

---

## Goal

Backend now keeps one **currently selected branch** per staff user.  
For doctor/receptionist/medical APIs, backend automatically scopes data to that selected branch.
Selectable branches are limited to branches assigned to that user in `tbl_user_branch_access`.

This means frontend should:

1. read branch scope after login
2. force branch selection if missing
3. allow user to change branch later
4. refresh branch-dependent screens after branch change

---

## Backend APIs

### 1) Login / refresh / profile response

These responses now include:

```json
{
  "branch_scope": {
    "required": true,
    "selected_branch_id": 2,
    "selected_branch": {
      "id": 2,
      "branch_name": "Indore Branch",
      "address": "Example address",
      "contact_no": "9999999999"
    },
    "available_branches": [
      {
        "id": 1,
        "branch_name": "Bhopal Branch",
        "address": "Example address",
        "contact_no": "8888888888",
        "is_selected": false
      },
      {
        "id": 2,
        "branch_name": "Indore Branch",
        "address": "Example address",
        "contact_no": "9999999999",
        "is_selected": true
      }
    ]
  }
}
```

Relevant endpoints:

- `POST /api/v1/auth/login`
- `POST /api/v1/auth/login/password`
- `POST /api/v1/auth/login/otp/verify`
- `POST /api/v1/auth/token/refresh`
- `GET /api/v1/auth/me`

---

### 2) Fetch selectable branches

`GET /api/v1/auth/branches`

Use this:

- on app boot after token restore
- before showing branch switcher
- after branch change if you want fresh branch metadata

This endpoint returns only the branches assigned to the logged-in staff user.

Response shape:

```json
{
  "success": true,
  "data": {
    "required": true,
    "selected_branch_id": 2,
    "selected_branch": {
      "id": 2,
      "branch_name": "Indore Branch"
    },
    "available_branches": []
  }
}
```

---

### 3) Update selected branch

`PUT /api/v1/auth/selected-branch`  
or  
`PATCH /api/v1/auth/selected-branch`

Body:

```json
{
  "branch_id": 2
}
```

Success response returns the latest branch scope payload.

---

## Required frontend flow

### After login

1. save token normally
2. read `data.branch_scope`
3. if role is `doctor` / `receptionist` / `medical` and `selected_branch_id` is `null`
   - open mandatory branch selection screen/modal
   - do not load branch-dependent staff dashboards before selection
4. after branch selection success
   - store selected branch in frontend state
   - reload branch-scoped screens

---

## When backend blocks access

If staff user has no selected branch and tries branch-scoped API:

### Response

HTTP `409`

```json
{
  "success": false,
  "message": "Please select a branch before using this module",
  "details": {
    "branch_selection_required": true
  }
}
```

### Frontend action

- intercept this response
- redirect/open branch selector
- call `GET /api/v1/auth/branches`
- submit `PUT /api/v1/auth/selected-branch`
- retry the original request if needed

---

## Important behavior for API consumption

### 1) You usually do not need to send `branch_id`

For staff module APIs, backend auto-applies selected branch.

So these are both okay:

```http
GET /api/v1/doctors/appointments
```

and

```http
GET /api/v1/doctors/appointments?branch_id=2
```

But if you send `branch_id`, it must match currently selected branch.

---

### 2) Do not send a different branch than selected branch

If selected branch is `2` and frontend sends `branch_id=1`, backend returns `403`.

So branch switcher must always:

1. first update selected branch via `/auth/selected-branch`
2. then call branch-dependent APIs

---

### 3) Branch switch should trigger data refresh

After successful branch change, frontend should refresh at least:

- doctor dashboard
- doctor appointments
- doctor reports/history
- receptionist appointments
- receptionist patients
- receptionist prescriptions
- medical prescriptions
- live queue staff screens
- bills screens used by staff

---

## Recommended frontend state

Keep these values in auth/session state:

```ts
type BranchScope = {
  required: boolean;
  selected_branch_id: number | null;
  selected_branch: {
    id: number;
    branch_name: string;
    address?: string | null;
    contact_no?: string | null;
  } | null;
  available_branches: Array<{
    id: number;
    branch_name: string;
    address?: string | null;
    contact_no?: string | null;
    is_selected: boolean;
  }>;
};
```

---

## Suggested UX

### Mandatory selection

For first login / no selected branch:

- fullscreen selection page
- or blocking modal
- no dismiss button

### Switch branch later

Provide branch switcher in:

- top navbar
- sidebar header
- profile menu

---

## Backend scope covered by this flow

This selected branch enforcement is wired for staff-facing backend flows in:

- doctor module
- receptionist module
- medical module
- staff bill access
- staff live-queue actions
- staff notifications (history + mark-read + realtime payload targeting)

---

## Recommended frontend implementation sequence

1. update auth store types to include `branch_scope`
2. after login, check `branch_scope.required`
3. add branch selector UI
4. call `PUT /api/v1/auth/selected-branch`
5. reload `/api/v1/auth/me`
6. reload branch-scoped module data
7. handle `409 branch_selection_required`
8. prevent stale branch-specific caches during branch switch

---

## Quick integration checklist

- [ ] auth store updated for `branch_scope`
- [ ] branch selector UI created
- [ ] no-selected-branch redirect/modal added
- [ ] branch switch API integrated
- [ ] staff screens refresh after branch change
- [ ] staff notifications refetch after branch change
- [ ] `409 branch_selection_required` handled
- [ ] `403 selected branch mismatch` handled
