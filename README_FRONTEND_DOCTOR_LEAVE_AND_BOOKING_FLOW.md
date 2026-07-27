# Frontend Flow: Doctor Leave Calendar + Booking Availability

Ye document frontend ke implemented flow ko explain karta hai, specially:

- doctor side leave calendar
- branch-wise leave selection
- multi-date / drag-range selection
- booking page availability check
- leave cancel ke baad booking behavior

---

## 1) Doctor menu entry

Doctor ke navigation me ab ek separate menu item diya gaya hai:

- `Leave Calendar`

Route:

```text
/doctor-leave-calendar
```

Doctor portal dashboard ke andar embedded calendar nahi hai. Calendar ko separate screen diya gaya hai taaki workflow clean rahe.

---

## 2) Doctor leave calendar screen

Frontend component:

```text
src/components/dashboard/DoctorLeaveCalendar.tsx
```

### Screen behavior

- selected branch required hoti hai
- current month compact calendar me show hota hai
- leave dates red state me show hoti hain
- user:
  - single date click karke select kar sakta hai
  - mouse hold + drag karke date range select kar sakta hai
  - multiple alag drag/click operations se aur dates add kar sakta hai

### Selection model

- `selectedDates[]` me current selection maintain hoti hai
- drag start date aur hover date se preview range banti hai
- mouse release par poori range selection me add ho jati hai

### Save flows

#### Mark selected dates as leave

API:

```http
POST /api/v1/doctors/leaves/bulk
```

Payload:

```json
{
  "branch_id": 1,
  "leave_dates": ["2026-05-28", "2026-05-29"],
  "leave_reason": "Out of station"
}
```

#### Remove selected leave dates

API:

```http
POST /api/v1/doctors/leaves/bulk-cancel
```

Payload:

```json
{
  "branch_id": 1,
  "leave_dates": ["2026-05-28", "2026-05-29"]
}
```

### Important UX rule

Leave cancel ka matlab:

- date UI se red leave state se nikal jaye
- uske baad booking page par same branch/date ke liye booking allowed ho

---

## 3) Booking page flow

Frontend component:

```text
src/components/Booking.tsx
```

### Booking fields relevant to leave logic

- branch
- appointment date
- slot

### Availability check trigger

Jab:

- `appointmentLocation` select ho
- `appointmentDate` select ho

tab frontend ye endpoint call karta hai:

```http
GET /api/v1/public/doctor-booking-availability?branch_id=<id>&date=YYYY-MM-DD
```

### UI behavior

#### If booking enabled

- green availability info dikhai jati hai
- slot dropdown active rahta hai
- submit button enabled reh sakta hai

#### If booking disabled

- red availability message show hota hai
- current selected slot clear kar diya jata hai
- slot dropdown disable ho jata hai
- submit button disable ho jata hai

---

## 4) Current booking rule

Implemented business rule:

- **active leave** → booking blocked
- **leave cancelled** → booking allowed
- doctor session start/pause state booking block nahi karti

Matlab:

> leave cancel ke baad booking allow honi chahiye, chahe doctor ne session start na kiya ho

Ye rule backend aur frontend dono me aligned hona chahiye.

---

## 5) Doctor status vs booking availability

Do alag concepts hain:

### A. Doctor status

Endpoint:

```http
GET /api/v1/public/doctor-status
```

Use:

- navbar
- public doctor availability display
- session in/out indicator

### B. Booking availability

Endpoint:

```http
GET /api/v1/public/doctor-booking-availability
```

Use:

- booking page
- receptionist booking page
- actual booking allow/block decision

Important:

- doctor status endpoint ko booking block decision ke liye use nahi karna chahiye

---

## 6) Files involved

### Frontend

- `src/App.tsx`
- `src/components/Navigation.tsx`
- `src/components/Booking.tsx`
- `src/components/DoctorPortal.tsx`
- `src/components/dashboard/DoctorLeaveCalendar.tsx`
- `src/components/CustomDatePicker.tsx`

### Backend

- `controllers/v1/doctorLeaveController.js`
- `services/doctorLeaveService.js`
- `routes/v1/doctorRoutes.js`
- `routes/v1/publicRoutes.js`
- `sql/2026-05-23_branch_doctor_leaves.sql`

---

## 7) Suggested manual test cases

### Case 1: mark leave

1. doctor selected branch choose kare
2. leave calendar me ek date select kare
3. mark leave save kare
4. booking page par same branch/date open kare
5. booking blocked hona chahiye

### Case 2: cancel leave

1. existing leave date select kare
2. remove selected leave kare
3. booking page par same branch/date open kare
4. booking allowed honi chahiye

### Case 3: session not started

1. doctor session start na kare
2. branch/date par koi active leave na ho
3. booking page par appointment try kare
4. booking allowed honi chahiye

### Case 4: drag range

1. leave calendar me mouse press + drag karo
2. multiple dates select honi chahiye
3. save selected dates
4. month list me sab dates appear honi chahiye

---

## 8) Migration reminder

Agar leave APIs 500 de rahi hain aur error aaye:

```text
tbl_branch_doctor_leaves doesn't exist
```

to ye SQL run karna hoga:

```text
sql/2026-05-23_branch_doctor_leaves.sql
```
