const { buildMedicalReportScope, query } = require('./shared');
const { decorateTokenFields } = require('../../../utils/tokenDisplay');

const getTestRegisterReport = async (filters) => {
    const { whereClause, params } = buildMedicalReportScope(filters);

    const rows = await query(
        `SELECT
            ct.id AS consultation_test_id,
            ct.consultation_id,
            ct.test_name,
            ct.amount,
            ct.dispense_status,
            ct.void_reason,
            ct.voided_at,
            ct.created_at AS recommended_at,
            f.finding_text,
            f.notes AS finding_notes,
            f.interpreted_at,
            c.doctor_id,
            c.doctor_finalized_at,
            a.appointment_id,
            a.appointment_date,
            a.auid,
            a.fk_branch_id,
            a.fk_slot_id,
            a.fk_patient_id,
            a.fk_patient_family_member_id,
            a.booked_for_type,
            a.original_token_number,
            a.current_token_number AS token_number,
            a.current_token_number,
            a.planned_start_at,
            a.planned_end_at,
            a.checked_in_at,
            COALESCE(fm.full_name, p.full_name) AS patient_full_name,
            COALESCE(fm.age, p.age) AS patient_age,
            COALESCE(fm.gender, p.gender) AS patient_gender,
            p.mobile_no AS patient_mobile_no,
            p.uuid AS patient_uuid,
            p.full_name AS primary_patient_full_name,
            fm.relationship AS family_member_relationship,
            d.full_name AS doctor_name,
            b.branch_name,
            t.treatment_name,
            s.slot_name,
            COALESCE(sto.override_start_time, s.start_time) AS start_time,
            COALESCE(sto.override_end_time, s.end_time) AS end_time
         FROM tbl_consultation_tests ct
         JOIN tbl_consultations c ON c.id = ct.consultation_id
         JOIN tbl_appointments a ON a.appointment_id = c.appointment_id
         JOIN master_users p ON p.id = a.fk_patient_id
         LEFT JOIN tbl_patient_family_members fm ON fm.id = a.fk_patient_family_member_id
         JOIN master_users d ON d.id = c.doctor_id
         JOIN master_clinic_branches b ON b.id = a.fk_branch_id
         JOIN master_treatments t ON t.id = a.fk_treatment_id
         JOIN master_slots s ON s.id = a.fk_slot_id
         LEFT JOIN tbl_doctor_slot_time_overrides sto
           ON sto.fk_branch_id = a.fk_branch_id
          AND sto.fk_slot_id = a.fk_slot_id
          AND sto.appointment_date = a.appointment_date
          AND sto.status = 'ACTIVE'
         LEFT JOIN tbl_consultation_test_findings f ON f.consultation_test_id = ct.id
         ${whereClause}
         ORDER BY
            a.appointment_date DESC,
            a.current_token_number ASC,
            a.appointment_id ASC,
            ct.id ASC`,
        params
    );

    return rows.map((row) => decorateTokenFields(row));
};

module.exports = getTestRegisterReport;
