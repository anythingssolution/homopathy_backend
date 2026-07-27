const { query, withTransaction } = require('../../../config/db');
const AppError = require('../../../utils/AppError');
const asyncHandler = require('../../../utils/asyncHandler');
const { createNotificationsForRole } = require('../../../utils/notificationService');
const { markAppointmentQueueCompleted, emitLiveQueueEvent } = require('../../../services/liveQueueService');
const { decorateTokenFields } = require('../../../utils/tokenDisplay');
const { normalizeRoleCode } = require('../../../utils/roles');
const { getCrossModuleAccessFlag } = require('../../../utils/moduleAccess');
const {
    getAppointmentPatientColumns,
    getAppointmentPatientJoin,
    getBookingSubjectExpression,
} = require('../../../utils/patientFamily');

const toPositiveInt = (value) => {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) {
        return null;
    }

    return parsed;
};

const isValidDateString = (value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));

const normalizeAppointmentStatus = (status) => {
    const normalized = String(status || '').trim().toLowerCase();
    const allowed = {
        pending: 'Pending',
        confirmed: 'Confirmed',
        completed: 'Completed',
        cancelled: 'Cancelled',
    };

    return allowed[normalized] || null;
};

const DOCTOR_APPOINTMENT_SELECT = `SELECT
    a.appointment_id,
    a.auid,
    a.fk_patient_id,
    a.parent_appointment_id,
    a.fk_branch_id,
    b.branch_name,
    a.fk_treatment_id,
    t.treatment_name,
    a.fk_slot_id,
    s.slot_name,
    COALESCE(sto.override_start_time, s.start_time) AS start_time,
    COALESCE(sto.override_end_time, s.end_time) AS end_time,
    s.default_consult_minutes,
    a.current_token_number AS token_number,
    a.appointment_date,
    a.original_token_number,
    a.current_token_number,
    a.is_shifted,
    a.shift_reason,
    a.not_available_at,
    a.booked_by_type,
    a.booked_by_user_id,
    a.rescheduled_from_appointment_id,
    a.reschedule_reason,
    a.queue_status,
    a.planned_start_at,
    a.planned_end_at,
    a.live_estimated_start_at,
    a.live_estimated_end_at,
    a.live_wait_minutes_snapshot,
    a.live_eta_updated_at,
    a.actual_called_at,
    a.actual_started_at,
    a.actual_completed_at,
    a.last_queue_event_at,
    a.checked_in_at,
    a.arrival_sequence,
    a.symptoms,
    a.status,
    a.reception_status,
    a.reception_approved_at,
    a.reception_approved_by,
    a.consultation_payment_status,
    a.consultation_bill_id,
    a.payment_collected_at,
    a.payment_collected_by,
    a.reception_rejected_at,
    a.reception_rejected_by,
    a.reception_rejection_reason,
    a.cancelled_at,
    a.cancelled_by_user_id,
    a.cancelled_by_role,
    a.cancel_reason,
    a.is_active,
    a.created_at,
    a.updated_at,
    c.id AS consultation_id,
    c.workflow_status AS consultation_workflow_status,
    CASE WHEN c.id IS NULL THEN 0 ELSE 1 END AS has_consultation,
    CASE
        WHEN c.id IS NULL
         AND a.is_active = 1
         AND a.status <> 'Cancelled'
         AND a.reception_status = 'APPROVED_BY_RECEPTION'
         AND a.consultation_payment_status = 'PAID' THEN 1
        ELSE 0
    END AS can_consult,
    v.oxygen_saturation,
    v.blood_pressure,
    v.patient_height,
    v.patient_weight,
    ${getAppointmentPatientColumns()}
 FROM tbl_appointments a
 JOIN master_clinic_branches b ON b.id = a.fk_branch_id
 JOIN master_treatments t ON t.id = a.fk_treatment_id
 JOIN master_slots s ON s.id = a.fk_slot_id
 LEFT JOIN tbl_doctor_slot_time_overrides sto
   ON sto.fk_branch_id = a.fk_branch_id
  AND sto.fk_slot_id = a.fk_slot_id
  AND sto.appointment_date = a.appointment_date
  AND sto.status = 'ACTIVE'
 LEFT JOIN tbl_consultations c ON c.appointment_id = a.appointment_id
 LEFT JOIN tbl_appointment_vitals v ON v.appointment_id = a.appointment_id
 ${getAppointmentPatientJoin()}`;

const ALLOWED_DURATION_DAYS = new Set([7, 15, 30]);
const ALLOWED_MEDICINE_TYPES = new Set(['NUMERIC', 'TEXT']);
const ALLOWED_CONSULTATION_MODES = new Set(['PHYSICAL_PRESENT', 'ON_CALL']);
const normalizeMasterValue = (value) => String(value || '').trim().toLowerCase();

const queryOptionalMasterTable = async (sql, params = []) => {
    try {
        return await query(sql, params);
    } catch (error) {
        if (error?.code === 'ER_NO_SUCH_TABLE') {
            return [];
        }

        throw error;
    }
};

const groupRowsByTextMedicine = (textMedicines, rows) => {
    const groupedRows = new Map(textMedicines.map((medicine) => [medicine.id, []]));
    const normalizedIdMap = new Map(textMedicines.map((medicine) => [medicine.normalized_value, medicine.id]));

    rows.forEach(({ normalized_product_name: normalizedProductName, ...row }) => {
        const medicineId = row.medicine_text_id || normalizedIdMap.get(normalizedProductName);

        if (!medicineId || !groupedRows.has(medicineId)) {
            return;
        }

        groupedRows.get(medicineId).push(row);
    });

    return groupedRows;
};

const splitMedicalProductRows = (textMedicines, rows) => {
    const medicalProducts = groupRowsByTextMedicine(textMedicines, rows);
    const products = new Map(textMedicines.map((medicine) => [medicine.id, []]));
    const radientPharmaProducts = new Map(textMedicines.map((medicine) => [medicine.id, []]));
    const handwrittenProductPrices = new Map(textMedicines.map((medicine) => [medicine.id, []]));

    medicalProducts.forEach((medicineProducts, medicineId) => {
        medicineProducts.forEach((product) => {
            const sourceType = String(product.source_type || '').toUpperCase();

            if (sourceType === 'REGULAR_PRODUCT') {
                products.get(medicineId).push(product);
                return;
            }

            if (sourceType === 'RADIENT_PHARMA') {
                radientPharmaProducts.get(medicineId).push({
                    ...product,
                    net_weight_or_size: product.size_or_weight,
                });
                return;
            }

            if (sourceType === 'MEDICAL_PRODUCT_PRICE') {
                handwrittenProductPrices.get(medicineId).push(product);
            }
        });
    });

    return {
        medicalProducts,
        products,
        radientPharmaProducts,
        handwrittenProductPrices,
    };
};

const buildTextMedicineProductMasters = async (textMedicines) => {
    const medicalProductRows = await queryOptionalMasterTable(
        `SELECT id, medicine_text_id, source_type, source_old_id, product_name,
                product_type, category, packing, size_or_weight, mrp_rate,
                price_min, price_max, shipper_size_pcs, description,
                formula_composition, normalized_category, normalized_product_name,
                is_active, created_at, updated_at
         FROM master_medical_products
         WHERE is_active = 1
         ORDER BY source_type ASC, product_name ASC, packing ASC, size_or_weight ASC, category ASC`
    );

    return splitMedicalProductRows(textMedicines, medicalProductRows);
};

const parseMedicineType = (value) => {
    const normalized = String(value || '').trim().toUpperCase();
    return ALLOWED_MEDICINE_TYPES.has(normalized) ? normalized : null;
};

const getDoctorAppointmentById = async (appointmentId, branchId = null) => {
    const params = [appointmentId];
    const branchCondition = branchId ? ' AND a.fk_branch_id = ?' : '';

    if (branchId) {
        params.push(branchId);
    }

    const appointments = await query(
        `${DOCTOR_APPOINTMENT_SELECT}
         WHERE a.appointment_id = ?
         ${branchCondition}
         LIMIT 1`,
        params
    );

    return decorateTokenFields(appointments[0] || null);
};

const STAFF_ACCESS_ROLE_MAP = {
    REC: {
        role_label: 'Receptionist',
        primary_module: 'RECEPTION',
        granted_module: 'MEDICAL',
        permission_label: 'Medical Module',
    },
    MED: {
        role_label: 'Medical',
        primary_module: 'MEDICAL',
        granted_module: 'RECEPTION',
        permission_label: 'Reception Module',
    },
};

const buildStaffAccessResponseRows = (rows = []) => {
    const rowMap = new Map(rows.map((row) => [normalizeRoleCode(row.role_code), row]));

    return ['REC', 'MED'].map((roleCode) => {
        const row = rowMap.get(roleCode) || {};
        const meta = STAFF_ACCESS_ROLE_MAP[roleCode];

        return {
            role_code: roleCode,
            role_label: meta.role_label,
            primary_module: meta.primary_module,
            granted_module: meta.granted_module,
            permission_label: meta.permission_label,
            total_users: Number(row.total_users) || 0,
            has_cross_module_access: getCrossModuleAccessFlag(row.has_cross_module_access),
        };
    });
};

const mapConsultationResponse = (consultationRow, medicationRows, testRows = []) => {
    const medicationMap = new Map();

    medicationRows.forEach((medication) => {
        if (!medicationMap.has(medication.consultation_medication_id)) {
            medicationMap.set(medication.consultation_medication_id, {
                consultation_medication_id: medication.consultation_medication_id,
                medicine_type: medication.medicine_type,
                medicine_value: medication.medicine_value,
                remark: medication.remark,
                added_by_role: medication.added_by_role || 'DOCTOR',
                doses: [],
            });
        }

        if (medication.medication_dosage_id) {
            medicationMap.get(medication.consultation_medication_id).doses.push({
                medication_dosage_id: medication.medication_dosage_id,
                dose_label: medication.dose_label,
                sort_order: medication.sort_order,
                times_per_day: medication.times_per_day,
                balls_per_dose: medication.balls_per_dose,
                instructions: medication.instructions,
            });
        }
    });

    return {
        consultation_id: consultationRow.consultation_id,
        appointment_id: consultationRow.appointment_id,
        doctor_id: consultationRow.doctor_id,
        doctor_uuid: consultationRow.doctor_uuid,
        doctor_name: consultationRow.doctor_name,
        medication_duration_days: consultationRow.medication_duration_days,
        follow_up_chain_closed: consultationRow.follow_up_chain_closed,
        follow_up_after_days: consultationRow.follow_up_after_days,
        repeated_from_consultation_id: consultationRow.repeated_from_consultation_id,
        consultation_mode: consultationRow.consultation_mode,
        oxygen_saturation: consultationRow.oxygen_saturation,
        blood_pressure: consultationRow.blood_pressure,
        patient_height: consultationRow.patient_height,
        patient_weight: consultationRow.patient_weight,
        occupation: consultationRow.occupation,
        history_present_illness: consultationRow.history_present_illness,
        history_past_illness: consultationRow.history_past_illness,
        family_history: consultationRow.family_history,
        allergies_history: consultationRow.allergies_history,
        gynecological_history: consultationRow.gynecological_history,
        personal_social_history: consultationRow.personal_social_history,
        general_examination: consultationRow.general_examination,
        systematic_examination: consultationRow.systematic_examination,
        differential_diagnosis: consultationRow.differential_diagnosis,
        follow_up: consultationRow.follow_up,
        disease: consultationRow.disease,
        diagnosis: consultationRow.diagnosis,
        mental_mind_status: consultationRow.mental_mind_status,
        formula_set_id: consultationRow.formula_set_id,
        formula_version_used: consultationRow.formula_version_used,
        quick_formula_input: consultationRow.quick_formula_input,
        workflow_status: consultationRow.workflow_status,
        doctor_finalized_at: consultationRow.doctor_finalized_at,
        reception_notified_at: consultationRow.reception_notified_at,
        reception_approved_at: consultationRow.reception_approved_at,
        reception_rejected_at: consultationRow.reception_rejected_at,
        reception_rejection_reason: consultationRow.reception_rejection_reason,
        sent_to_medical_at: consultationRow.sent_to_medical_at,
        medical_processed_at: consultationRow.medical_processed_at,
        symptoms: consultationRow.symptoms,
        treatment_advice: consultationRow.treatment_advice,
        created_at: consultationRow.created_at,
        updated_at: consultationRow.updated_at,
        medications: Array.from(medicationMap.values()),
        tests: testRows.map((test) => ({
            consultation_test_id: test.consultation_test_id,
            test_name: test.test_name,
            amount: test.amount,
        })),
    };
};

const getConsultationAggregateByAppointmentId = async (appointmentId) => {
    const consultationRows = await query(
        `SELECT
            c.id AS consultation_id,
            c.appointment_id,
            c.doctor_id,
            d.uuid AS doctor_uuid,
            d.full_name AS doctor_name,
            c.symptoms,
            c.treatment_advice,
            c.medication_duration_days,
            c.follow_up_chain_closed,
            c.follow_up_after_days,
            c.repeated_from_consultation_id,
            c.consultation_mode,
            c.oxygen_saturation,
            c.blood_pressure,
            c.patient_height,
            c.patient_weight,
            c.occupation,
            c.history_present_illness,
            c.history_past_illness,
            c.family_history,
            c.allergies_history,
            c.gynecological_history,
            c.personal_social_history,
            c.general_examination,
            c.systematic_examination,
            c.differential_diagnosis,
            c.follow_up,
            c.disease,
            c.diagnosis,
            c.mental_mind_status,
            c.formula_set_id,
            c.formula_version_used,
            c.quick_formula_input,
            c.workflow_status,
            c.doctor_finalized_at,
            c.reception_notified_at,
            c.reception_approved_at,
            c.reception_rejected_at,
            c.reception_rejection_reason,
            c.sent_to_medical_at,
            c.medical_processed_at,
            c.created_at,
            c.updated_at
         FROM tbl_consultations c
         JOIN master_users d ON d.id = c.doctor_id
         WHERE c.appointment_id = ?
         LIMIT 1`,
        [appointmentId]
    );

    if (consultationRows.length === 0) {
        return null;
    }

    const medicationRows = await query(
        `SELECT
            cm.id AS consultation_medication_id,
            cm.medicine_type,
            cm.medicine_value,
            cm.remark,
            cm.added_by_role,
            md.id AS medication_dosage_id,
            md.dose_label,
            md.sort_order,
            md.times_per_day,
            md.balls_per_dose,
            md.instructions
         FROM tbl_consultation_medications cm
         LEFT JOIN tbl_medication_dosages md
           ON md.consultation_medication_id = cm.id
         WHERE cm.consultation_id = ?
         ORDER BY cm.id ASC, COALESCE(md.sort_order, 999) ASC, md.id ASC`,
        [consultationRows[0].consultation_id]
    );

    const testRows = await query(
        `SELECT
            id AS consultation_test_id,
            test_name,
            amount
         FROM tbl_consultation_tests
         WHERE consultation_id = ?
         ORDER BY id ASC`,
        [consultationRows[0].consultation_id]
    );

    return mapConsultationResponse(consultationRows[0], medicationRows, testRows);
};

const getMedicalPricingAggregateByConsultationId = async (consultationId) => {
    const pricingRows = await query(
        `SELECT
            id AS pricing_id,
            consultation_id,
            total_amount,
            remark,
            created_by,
            updated_by,
            created_at,
            updated_at
         FROM tbl_medical_prescription_pricing
         WHERE consultation_id = ?
         LIMIT 1`,
        [consultationId]
    );

    if (pricingRows.length === 0) {
        return null;
    }

    const itemRows = await query(
        `SELECT
            id AS pricing_item_id,
            consultation_medication_id,
            medicine_value,
            amount,
            created_at,
            updated_at
         FROM tbl_medical_prescription_pricing_items
         WHERE pricing_id = ?
         ORDER BY id ASC`,
        [pricingRows[0].pricing_id]
    );

    return {
        ...pricingRows[0],
        medications: itemRows,
    };
};

const enrichAppointmentChainWithConsultationData = async (chainRows = []) => Promise.all(
    chainRows.map(async (row) => {
        if (!row.consultation_id) {
            return {
                ...row,
                consultation: null,
                pricing: null,
            };
        }

        const consultation = await getConsultationAggregateByAppointmentId(row.appointment_id);
        const pricing = await getMedicalPricingAggregateByConsultationId(row.consultation_id);

        return {
            ...row,
            consultation,
            pricing,
        };
    })
);

const getConsultationHistoryRows = async ({ branchId = null, fromDate = null, toDate = null, patientSearch = null }) => {
    const conditions = [];
    const params = [];

    if (branchId) {
        conditions.push('a.fk_branch_id = ?');
        params.push(branchId);
    }

    if (fromDate) {
        conditions.push('a.appointment_date >= ?');
        params.push(fromDate);
    }

    if (toDate) {
        conditions.push('a.appointment_date <= ?');
        params.push(toDate);
    }

    if (patientSearch) {
        conditions.push('(COALESCE(fm.full_name, p.full_name) LIKE ? OR p.full_name LIKE ? OR p.mobile_no LIKE ? OR p.uuid LIKE ?)');
        params.push(`%${patientSearch}%`, `%${patientSearch}%`, `%${patientSearch}%`, `%${patientSearch}%`);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    return query(
        `SELECT
            c.id AS consultation_id,
            c.appointment_id,
            c.doctor_id,
            d.uuid AS doctor_uuid,
            d.full_name AS doctor_name,
            c.symptoms AS consultation_symptoms,
            c.treatment_advice,
            c.medication_duration_days,
            c.follow_up_chain_closed,
            c.created_at AS consultation_created_at,
            c.updated_at AS consultation_updated_at,
            a.auid,
            a.fk_patient_id,
            a.parent_appointment_id,
            a.fk_branch_id,
            b.branch_name,
            a.fk_treatment_id,
            t.treatment_name,
            a.fk_slot_id,
            s.slot_name,
            COALESCE(sto.override_start_time, s.start_time) AS start_time,
            COALESCE(sto.override_end_time, s.end_time) AS end_time,
            a.current_token_number AS token_number,
            a.original_token_number,
            a.current_token_number,
            a.is_shifted,
            a.shift_reason,
            a.not_available_at,
            a.booked_by_type,
            a.booked_by_user_id,
            a.rescheduled_from_appointment_id,
            a.reschedule_reason,
            a.appointment_date,
            a.symptoms AS appointment_symptoms,
            a.status AS appointment_status,
            a.cancelled_at,
            a.cancelled_by_user_id,
            a.cancelled_by_role,
            a.cancel_reason,
            a.is_active,
            a.created_at AS appointment_created_at,
            a.updated_at AS appointment_updated_at,
            ${getAppointmentPatientColumns()}
         FROM tbl_consultations c
         JOIN tbl_appointments a ON a.appointment_id = c.appointment_id
         JOIN master_users d ON d.id = c.doctor_id
         JOIN master_clinic_branches b ON b.id = a.fk_branch_id
         JOIN master_treatments t ON t.id = a.fk_treatment_id
         JOIN master_slots s ON s.id = a.fk_slot_id
         LEFT JOIN tbl_doctor_slot_time_overrides sto
           ON sto.fk_branch_id = a.fk_branch_id
          AND sto.fk_slot_id = a.fk_slot_id
          AND sto.appointment_date = a.appointment_date
          AND sto.status = 'ACTIVE'
         ${getAppointmentPatientJoin()}
         ${whereClause}
         ORDER BY c.created_at DESC, c.id DESC`,
        params
    );
};

const validateConsultationPayload = (body) => {
    const toNonNegativeAmount = (value) => {
        const parsed = Number(value);
        if (!Number.isFinite(parsed) || parsed < 0) {
            return null;
        }

        return Number(parsed.toFixed(2));
    };

    const toNullableText = (value) => {
        if (value === undefined || value === null) {
            return null;
        }

        const parsed = String(value).trim();
        return parsed ? parsed : null;
    };

    const toNullableVarchar = (value, maxLength, fieldLabel) => {
        const parsed = toNullableText(value);
        if (!parsed) {
            return null;
        }

        if (parsed.length > maxLength) {
            throw new AppError(`${fieldLabel} must be at most ${maxLength} characters`, 400);
        }

        return parsed;
    };

    const appointmentId = toPositiveInt(body?.appointment_id);
    const medicationDurationDays = toPositiveInt(body?.medication_duration_days);
    const followUpAfterDays = toPositiveInt(body?.follow_up_after_days ?? body?.followUpAfterDays ?? 15);
    const repeatedFromConsultationId = toPositiveInt(
        body?.repeated_from_consultation_id ?? body?.repeatedFromConsultationId
    );
    const hasRepeatedFromConsultationId = body?.repeated_from_consultation_id !== undefined
        || body?.repeatedFromConsultationId !== undefined;
    const consultationMode = String(body?.consultation_mode || 'PHYSICAL_PRESENT').trim().toUpperCase();
    const hasNoAdvice = body?.has_no_advice === true
        || body?.hasNoAdvice === true
        || body?.allow_no_prescription === true
        || body?.allowNoPrescription === true
        || body?.has_no_advice === 1
        || body?.hasNoAdvice === 1
        || body?.allow_no_prescription === 1
        || body?.allowNoPrescription === 1
        || String(
            body?.has_no_advice
            || body?.hasNoAdvice
            || body?.allow_no_prescription
            || body?.allowNoPrescription
            || ''
        ).trim().toLowerCase() === 'true';
    const oxygenSaturation = body?.oxygen_saturation ? String(body.oxygen_saturation).trim() : null;
    const bloodPressure = body?.blood_pressure ? String(body.blood_pressure).trim() : null;
    const patientHeight = body?.patient_height ? String(body.patient_height).trim() : null;
    const patientWeight = body?.patient_weight ? String(body.patient_weight).trim() : null;
    const symptoms = String(body?.symptoms || '').trim();
    let treatmentAdvice = toNullableText(body?.treatment_advice);
    const followUpChainClosed = body?.follow_up_chain_closed === true
        || body?.followUpChainClosed === true
        || body?.follow_up_chain_closed === 1
        || body?.followUpChainClosed === 1
        || String(body?.follow_up_chain_closed || body?.followUpChainClosed || '').trim().toLowerCase() === 'true';
    let diagnosis = toNullableText(body?.diagnosis);
    if (!diagnosis && treatmentAdvice && treatmentAdvice.startsWith('Diagnosis: ')) {
        const parts = treatmentAdvice.split('\n\n');
        diagnosis = toNullableText(parts[0].replace('Diagnosis: ', ''));
        treatmentAdvice = parts.slice(1).join('\n\n').trim() || treatmentAdvice;
    }
    const occupation = toNullableText(body?.occupation);
    const historyPresentIllness = toNullableText(body?.history_present_illness ?? body?.historyPresentIllness);
    const historyPastIllness = toNullableText(body?.history_past_illness ?? body?.historyPastIllness);
    const familyHistory = toNullableText(body?.family_history ?? body?.familyHistory);
    const allergiesHistory = toNullableText(body?.allergies_history ?? body?.allergiesHistory);
    const gynecologicalHistory = toNullableText(body?.gynecological_history ?? body?.gynecologicalHistory);
    const personalSocialHistory = toNullableText(body?.personal_social_history ?? body?.personalSocialHistory);
    const generalExamination = toNullableText(body?.general_examination ?? body?.generalExamination);
    const systematicExamination = toNullableText(body?.systematic_examination ?? body?.systematicExamination);
    const differentialDiagnosis = toNullableText(body?.differential_diagnosis ?? body?.differentialDiagnosis);
    const followUp = toNullableText(body?.follow_up ?? body?.followUp);
    const disease = toNullableVarchar(body?.disease, 255, 'Disease');
    const mentalMindStatus = toNullableText(body?.mental_mind_status ?? body?.mentalMindStatus);
    const formulaSetId = toPositiveInt(body?.formula_set_id ?? body?.formulaSetId);
    const formulaVersionUsed = toPositiveInt(body?.formula_version_used ?? body?.formulaVersionUsed);
    const quickFormulaInput = toNullableText(body?.quick_formula_input ?? body?.quickFormulaInput);
    const medicationsInput = Array.isArray(body?.medications) ? body.medications : null;
    const testsInput = Array.isArray(body?.tests) ? body.tests : [];

    if (!appointmentId) {
        throw new AppError('Please select a valid appointment', 400);
    }

    if (!ALLOWED_DURATION_DAYS.has(medicationDurationDays)) {
        throw new AppError('Please select medication duration (7, 15 or 30 days)', 400);
    }

    if (!followUpAfterDays || followUpAfterDays > 365) {
        throw new AppError('follow_up_after_days must be between 1 and 365', 400);
    }

    if (hasRepeatedFromConsultationId
        && body?.repeated_from_consultation_id !== null
        && body?.repeatedFromConsultationId !== null
        && !repeatedFromConsultationId) {
        throw new AppError('repeated_from_consultation_id must be a positive integer', 400);
    }

    if (!ALLOWED_CONSULTATION_MODES.has(consultationMode)) {
        throw new AppError('Consultation mode must be PHYSICAL_PRESENT or ON_CALL', 400);
    }

    const medicationsSource = medicationsInput || [];

    if (!hasNoAdvice && !symptoms) {
        throw new AppError('Symptoms are required', 400);
    }

    if (!hasNoAdvice && medicationsSource.length === 0) {
        throw new AppError('Please add at least one medication', 400);
    }

    const medications = medicationsSource.map((medication, index) => {
        const medicineType = parseMedicineType(medication?.medicine_type);
        const rawMedicineValue = medication?.medicine_value;
        if (!medicineType) {
            throw new AppError(`medications[${index}].medicine_type must be NUMERIC or TEXT`, 400);
        }

        let medicineValue = null;
        const amount = toNonNegativeAmount(medication?.amount);

        if (medication?.amount === undefined || medication?.amount === null || medication?.amount === '') {
            throw new AppError('Please enter amount for each medication', 400);
        }

        if (amount === null) {
            throw new AppError('Medication amount must be a valid non-negative number', 400);
        }

        if (medicineType === 'NUMERIC') {
            const numericValue = toPositiveInt(rawMedicineValue);

            if (!numericValue || numericValue < 3 || numericValue > 150) {
                throw new AppError(`medications[${index}].medicine_value must be between 3 and 150 for NUMERIC type`, 400);
            }

            medicineValue = String(numericValue);
        } else {
            medicineValue = String(rawMedicineValue || '').trim();

            if (!medicineValue) {
                throw new AppError(`medications[${index}].medicine_value is required for TEXT type`, 400);
            }
        }

        const remark = medication?.remark ? String(medication.remark).trim() : null;
        let dosesInput = Array.isArray(medication?.doses) ? medication.doses : null;

        if ((!dosesInput || dosesInput.length === 0) && medication?.dosage) {
            dosesInput = [
                {
                    dose_label: 'DOSE_1',
                    sort_order: 1,
                    times_per_day: medication.dosage.times_per_day,
                    balls_per_dose: medication.dosage.balls_per_dose,
                    instructions: medication.dosage.instructions,
                },
            ];
        }

        if ((!dosesInput || dosesInput.length === 0) && medicineType === 'NUMERIC') {
            throw new AppError(`medications[${index}].doses must contain at least one row for NUMERIC type`, 400);
        }

        const doses = (dosesInput || []).map((dose, doseIndex) => {
            const timesPerDay = toPositiveInt(dose?.times_per_day);
            const ballsPerDose = toPositiveInt(dose?.balls_per_dose);
            const doseLabel = String(dose?.dose_label || `DOSE_${doseIndex + 1}`).trim();
            const sortOrder = toPositiveInt(dose?.sort_order) || (doseIndex + 1);
            const instructions = dose?.instructions ? String(dose.instructions).trim() : null;

            if (!timesPerDay) {
                throw new AppError(`medications[${index}].doses[${doseIndex}].times_per_day must be a positive integer`, 400);
            }

            if (!ballsPerDose) {
                throw new AppError(`medications[${index}].doses[${doseIndex}].balls_per_dose must be a positive integer`, 400);
            }

            return {
                dose_label: doseLabel,
                sort_order: sortOrder,
                times_per_day: timesPerDay,
                balls_per_dose: ballsPerDose,
                instructions,
            };
        });

        return {
            medicine_type: medicineType,
            medicine_value: medicineValue,
            remark: medicineType === 'TEXT' ? remark : null,
            doses,
            amount,
        };
    });

    const tests = testsInput.map((test) => {
        const testName = String(test?.test_name || '').trim();
        const amount = toNonNegativeAmount(test?.amount);

        if (!testName) {
            throw new AppError('Test name is required', 400);
        }

        if (test?.amount === undefined || test?.amount === null || test?.amount === '') {
            throw new AppError('Please enter amount for each test', 400);
        }

        if (amount === null) {
            throw new AppError('Test amount must be a valid non-negative number', 400);
        }

        return {
            test_name: testName,
            amount,
        };
    });

    const computedTotalAmount = Number(
        (
            medications.reduce((sum, medication) => sum + (Number(medication.amount) || 0), 0)
            + tests.reduce((sum, test) => sum + (Number(test.amount) || 0), 0)
        ).toFixed(2)
    );

    const hasMeaningfulTextField = [
        symptoms,
        diagnosis,
        treatmentAdvice,
        occupation,
        historyPresentIllness,
        historyPastIllness,
        familyHistory,
        allergiesHistory,
        gynecologicalHistory,
        personalSocialHistory,
        generalExamination,
        systematicExamination,
        differentialDiagnosis,
        followUp,
        disease,
        mentalMindStatus,
    ].some(Boolean);

    const hasMeaningfulStructuredData = medications.length > 0 || tests.length > 0;

    if (hasNoAdvice && !hasMeaningfulTextField && !hasMeaningfulStructuredData) {
        throw new AppError('Please enter at least one consultation detail before saving', 400);
    }

    return {
        appointmentId,
        medicationDurationDays,
        followUpAfterDays,
        repeatedFromConsultationId,
        followUpChainClosed,
        consultationMode,
        hasNoAdvice,
        oxygenSaturation,
        bloodPressure,
        patientHeight,
        patientWeight,
        symptoms,
        diagnosis,
        treatmentAdvice,
        occupation,
        historyPresentIllness,
        historyPastIllness,
        familyHistory,
        allergiesHistory,
        gynecologicalHistory,
        personalSocialHistory,
        generalExamination,
        systematicExamination,
        differentialDiagnosis,
        followUp,
        disease,
        mentalMindStatus,
        formulaSetId,
        formulaVersionUsed,
        quickFormulaInput,
        medications,
        tests,
        totalAmount: computedTotalAmount,
    };
};

module.exports = {
    query,
    withTransaction,
    AppError,
    asyncHandler,
    createNotificationsForRole,
    markAppointmentQueueCompleted,
    emitLiveQueueEvent,
    decorateTokenFields,
    normalizeRoleCode,
    getCrossModuleAccessFlag,
    getAppointmentPatientColumns,
    getAppointmentPatientJoin,
    getBookingSubjectExpression,
    toPositiveInt,
    isValidDateString,
    normalizeAppointmentStatus,
    DOCTOR_APPOINTMENT_SELECT,
    normalizeMasterValue,
    buildTextMedicineProductMasters,
    getDoctorAppointmentById,
    STAFF_ACCESS_ROLE_MAP,
    buildStaffAccessResponseRows,
    getConsultationAggregateByAppointmentId,
    getMedicalPricingAggregateByConsultationId,
    enrichAppointmentChainWithConsultationData,
    getConsultationHistoryRows,
    validateConsultationPayload,
};
