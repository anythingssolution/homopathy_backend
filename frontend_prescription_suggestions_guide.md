# Frontend Implementation Guide: Previous Prescription Suggestions

This document provides a comprehensive guide for frontend developers or AI code assistants to integrate the **Previous Prescription Suggestions** feature into the doctor consultation portal.

---

## 1. Feature Description
When a doctor is filling out a consultation form for a patient, the system should suggest previous prescription combinations based on the entered symptoms or diagnosis. 
* **Case 1 (Patient's History - Priority 1)**: If this specific patient was previously treated for the same symptoms/diagnosis, suggest the previous prescription combinations.
* **Case 2 (Global History - Fallback)**: If the patient is new or has no historical records matching the symptoms/diagnosis, suggest matching prescription combinations used for other patients.

---

## 2. API Specifications

### Get Prescription Suggestions
Fetch unique prescription combination strings (quick formulas) matching the symptoms/diagnosis.

* **Endpoint**: `GET /api/v1/doctors/consultations/prescription-suggestions`
* **Headers**:
  * `Authorization: Bearer <ACCESS_TOKEN>`
* **Query Parameters**:
  * `appointment_id` (Integer, Required): The current appointment ID (used to determine the patient ID).
  * `symptoms` (String, Optional): The symptoms/conditions entered.
  * `diagnosis` (String, Optional): The diagnosis entered.

#### Example Request URL:
```http
GET http://localhost:3000/api/v1/doctors/consultations/prescription-suggestions?appointment_id=101&symptoms=Fever
```

#### Example Response JSON:
```json
{
  "success": true,
  "message": "Prescription suggestions fetched successfully",
  "basis": "PATIENT_HISTORY", // Or "GLOBAL_HISTORY" (fallback)
  "data": [
    "5,7,9",
    "2,4,6"
  ]
}
```

---

## 3. UI Behavior & Interaction Flow

1. **Trigger Suggestion Fetching**:
   - The UI should monitor input changes on the **Symptoms** and **Diagnosis** input fields in the Consultation Form.
   - Use a **debounce of 500ms** to avoid excessive API requests while typing.
   - When the user stops typing, trigger a query to the backend suggestions endpoint with the current `appointment_id`, `symptoms`, and `diagnosis`.

2. **Render Suggestions Widget**:
   - Render a "Previous Suggestions" card/panel below the prescription entry table.
   - Show the matching basis label: `"Based on Patient's History"` (if `basis === 'PATIENT_HISTORY'`) or `"Based on Global History"` (if `basis === 'GLOBAL_HISTORY'`).
   - Display each prescription set as a separate click-to-apply card/block (e.g., a badge with the text `"Formula: 5,7,9"`).

3. **Auto-Fill Form on Click**:
   - When a doctor clicks on a suggested prescription string (e.g., `"5,7,9"`), set the consultation form's **Quick Formula Input** field value to this string.
   - Triggering this will automatically populate the medicine prescriptions.
