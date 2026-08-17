const bcrypt = require('bcryptjs');
const { randomUUID } = require('crypto');
const { query, withTransaction } = require('../../config/db');
const AppError = require('../../utils/AppError');
const asyncHandler = require('../../utils/asyncHandler');
const {
    createConsultationBillForAppointment,
    transferConsultationBillToAppointment,
    collectConsultationBillPayment,
    getBillDetailById,
    normalizeAmount,
    PAYMENT_SETTLEMENT_TYPES,
} = require('../../services/billingService');
const {
    QUEUE_STATUS,
    ACTIVE_QUEUE_STATUSES,
    logQueueEvent,
    recalculateQueuePlan,
    emitLiveQueueEvent,
    sortAppointmentsByRuntimeQueue,
    buildPlateBlankTimelineRows,
    getSlotQueueContext,
    getActiveProtectedWindowAppointmentIds,
} = require('../../services/liveQueueService');
const { assertBranchDoctorAvailableForBooking } = require('../../services/doctorLeaveService');
const { emitToRole } = require('../../utils/realtime');
const { decorateTokenFields } = require('../../utils/tokenDisplay');
const { projectDispensingStatus } = require('../../services/dispensaryPricingService');
const {
    BOOKED_FOR_TYPES,
    MAX_ACTIVE_FAMILY_MEMBERS,
    normalizeBookedForType,
    getAppointmentPatientColumns,
    getAppointmentPatientJoin,
    buildBookingConflictCondition,
    getBookingSubjectKey,
} = require('../../utils/patientFamily');
const {
    buildFollowUpMeta,
    getTreatmentById,
    isFollowUpBookingVisitType,
    getVisitTypeCode,
    lockEligiblePendingFollowUp,
    markPendingFollowUpBooked,
} = require('../../services/followupService');
const {
    MAX_TOKEN_NUMBER,
    assignAppointmentTokenNumbers,
    buildSlotTokenPlate,
    getBranchMaxTokenNumber,
    getBranchTokenPlateRules,
    getPlateTokenByNumber,
    getNextAvailableTokenNumber,
    supportsTokenPlateVisitType,
} = require('../../utils/appointmentTokens');
const { buildEffectiveSlotTokenPlate } = require('../../services/slotTokenExtensionService');
const { resolveEffectiveSlotTiming } = require('../../services/slotTimeOverrideService');
const APPOINTMENT_AUID_PREFIX = 'AUID';
const PATIENT_ROLE = 'PAT';

const toPositiveInt = (value) => {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) {
        return null;
    }

    return parsed;
};

const isValidDateString = (value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
const normalizeQueueDateKey = (value) => {
    if (!value) {
        return '';
    }

    if (value instanceof Date && !Number.isNaN(value.getTime())) {
        return [
            value.getFullYear(),
            String(value.getMonth() + 1).padStart(2, '0'),
            String(value.getDate()).padStart(2, '0'),
        ].join('-');
    }

    const stringValue = String(value).trim();
    return stringValue.includes('T') ? stringValue.split('T')[0] : stringValue.slice(0, 10);
};
const validateGender = (gender) => ['male', 'female', 'other'].includes(String(gender || '').toLowerCase());
const validateMobile = (mobileNo) => /^[0-9]{10,15}$/.test(String(mobileNo || '').trim());
const parseJsonColumn = (value, fallback) => {
    if (value === undefined || value === null) {
        return fallback;
    }

    if (typeof value === 'object') {
        return value;
    }

    try {
        return JSON.parse(value);
    } catch (_error) {
        return fallback;
    }
};

const toNullableTrimmedText = (value, maxLength = 50) => {
    if (value === undefined || value === null) {
        return null;
    }

    const normalized = String(value).trim();
    if (!normalized) {
        return null;
    }

    return normalized.slice(0, maxLength);
};

const parseAppointmentVitalsPayload = (body = {}) => {
    const oxygenSaturation = toNullableTrimmedText(body.oxygen_saturation, 20);
    const bloodPressure = toNullableTrimmedText(body.blood_pressure, 20);
    const patientHeight = toNullableTrimmedText(body.patient_height, 20);
    const patientWeight = toNullableTrimmedText(body.patient_weight, 20);

    const occupation = toNullableTrimmedText(body.occupation, 255);
    const historyPresentIllness = toNullableTrimmedText(body.history_present_illness ?? body.historyPresentIllness, 5000);
    const historyPastIllness = toNullableTrimmedText(body.history_past_illness ?? body.historyPastIllness, 5000);
    const familyHistory = toNullableTrimmedText(body.family_history ?? body.familyHistory, 5000);
    const allergiesHistory = toNullableTrimmedText(body.allergies_history ?? body.allergiesHistory, 5000);
    const gynecologicalHistory = toNullableTrimmedText(body.gynecological_history ?? body.gynecologicalHistory, 5000);
    const personalSocialHistory = toNullableTrimmedText(body.personal_social_history ?? body.personalSocialHistory, 5000);
    const generalExamination = toNullableTrimmedText(body.general_examination ?? body.generalExamination, 5000);
    const systematicExamination = toNullableTrimmedText(body.systematic_examination ?? body.systematicExamination, 5000);
    const differentialDiagnosis = toNullableTrimmedText(body.differential_diagnosis ?? body.differentialDiagnosis, 5000);
    const followUp = toNullableTrimmedText(body.follow_up ?? body.followUp, 5000);
    const disease = toNullableTrimmedText(body.disease, 255);
    const mentalMindStatus = toNullableTrimmedText(body.mental_mind_status ?? body.mentalMindStatus, 5000);

    return {
        oxygen_saturation: oxygenSaturation,
        blood_pressure: bloodPressure,
        patient_height: patientHeight,
        patient_weight: patientWeight,
        occupation,
        history_present_illness: historyPresentIllness,
        history_past_illness: historyPastIllness,
        family_history: familyHistory,
        allergies_history: allergiesHistory,
        gynecological_history: gynecologicalHistory,
        personal_social_history: personalSocialHistory,
        general_examination: generalExamination,
        systematic_examination: systematicExamination,
        differential_diagnosis: differentialDiagnosis,
        follow_up: followUp,
        disease,
        mental_mind_status: mentalMindStatus,
        has_any_value: Boolean(
            oxygenSaturation || bloodPressure || patientHeight || patientWeight ||
            occupation || historyPresentIllness || historyPastIllness || familyHistory ||
            allergiesHistory || gynecologicalHistory || personalSocialHistory ||
            generalExamination || systematicExamination || differentialDiagnosis ||
            followUp || disease || mentalMindStatus
        ),
    };
};

let vitalsColumnsEnsured = false;
const ensureVitalsColumnsExist = async () => {
    if (vitalsColumnsEnsured) return;
    try {
        const targetColumns = [
            { name: 'occupation', type: 'VARCHAR(255)' },
            { name: 'history_present_illness', type: 'TEXT' },
            { name: 'history_past_illness', type: 'TEXT' },
            { name: 'family_history', type: 'TEXT' },
            { name: 'allergies_history', type: 'TEXT' },
            { name: 'gynecological_history', type: 'TEXT' },
            { name: 'personal_social_history', type: 'TEXT' },
            { name: 'general_examination', type: 'TEXT' },
            { name: 'systematic_examination', type: 'TEXT' },
            { name: 'differential_diagnosis', type: 'TEXT' },
            { name: 'follow_up', type: 'TEXT' },
            { name: 'disease', type: 'VARCHAR(255)' },
            { name: 'mental_mind_status', type: 'TEXT' },
        ];

        const existing = await query(
            `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'tbl_appointment_vitals' AND TABLE_SCHEMA = DATABASE()`
        );
        const existingColNames = new Set(existing.map((row) => String(row.COLUMN_NAME).toLowerCase()));

        for (const col of targetColumns) {
            if (!existingColNames.has(col.name.toLowerCase())) {
                try {
                    await query(`ALTER TABLE tbl_appointment_vitals ADD COLUMN ${col.name} ${col.type} NULL`);
                } catch (colErr) {
                    console.error(`Could not add column ${col.name}:`, colErr.message);
                }
            }
        }
        vitalsColumnsEnsured = true;
    } catch (err) {
        console.error('Error ensuring vitals columns exist:', err.message);
    }
};

const normalizeFamilyMemberPayload = (body = {}) => {
    const fullName = String(body.full_name || '').trim();
    const relationship = String(body.relationship || '').trim();
    const age = toPositiveInt(body.age);
    const gender = String(body.gender || '').trim().toLowerCase();
    const description = body.description ? String(body.description).trim() : null;

    if (!fullName) {
        throw new AppError('full_name is required', 400);
    }

    if (!relationship) {
        throw new AppError('relationship is required', 400);
    }

    if (!age) {
        throw new AppError('age must be a positive integer', 400);
    }

    if (!validateGender(gender)) {
        throw new AppError("gender must be one of 'male', 'female' or 'other'", 400);
    }

    return {
        full_name: fullName,
        relationship,
        age,
        gender,
        description,
    };
};

const parsePaymentCollectionPayload = (payload = {}) => {
    const paymentMode = String(payload.payment_mode || '').trim().toUpperCase();
    const amount = normalizeAmount(payload.amount);
    const transactionReference = payload.transaction_reference ? String(payload.transaction_reference).trim() : null;
    const remark = payload.remark ? String(payload.remark).trim() : null;

    if (!paymentMode) {
        throw new AppError('payment_mode is required', 400);
    }

    if (amount === null) {
        throw new AppError('amount must be a valid non-negative number', 400);
    }

    if (paymentMode === 'ONLINE' && !transactionReference) {
        throw new AppError('transaction_reference is required when payment_mode is ONLINE', 400);
    }

    return {
        paymentMode,
        amount,
        transactionReference,
        remark,
    };
};

const validateSlotBookingCutoff = ({ appointmentDate, slotEndTime, now = new Date() }) => {
    // Receptionist side cutoff condition disabled as per requirement
    return;
};

const getClientIp = (req) => {
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) {
        return forwarded.split(',')[0].trim();
    }

    return req.ip || req.socket?.remoteAddress || '0.0.0.0';
};

const formatDateForPublicId = (date = new Date()) => {
    const day = String(date.getDate()).padStart(2, '0');
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const year = String(date.getFullYear());

    return `${day}${month}${year}`;
};

const generateTodayPatientUuid = async (connection, date = new Date()) => {
    const datePart = formatDateForPublicId(date);
    const prefix = `PAT${datePart}`;
    const lockName = `patient_uuid_${datePart}`;

    const [lockRows] = await connection.execute('SELECT GET_LOCK(?, 10) AS acquired_lock', [lockName]);

    if (!lockRows[0]?.acquired_lock) {
        throw new AppError('Unable to generate patient ID right now. Please try again.', 503);
    }

    try {
        const [existingRows] = await connection.execute(
            `SELECT uuid
             FROM master_users
             WHERE uuid LIKE ?
             ORDER BY uuid DESC
             LIMIT 1`,
            [`${prefix}%`]
        );

        const lastUuid = existingRows[0]?.uuid || null;
        const lastSerial = lastUuid ? Number(String(lastUuid).slice(prefix.length)) : 0;
        const nextSerial = lastSerial + 1;

        if (nextSerial > 9999) {
            throw new AppError('Daily patient registration limit exceeded for PAT ID generation', 409);
        }

        return `${prefix}${String(nextSerial).padStart(4, '0')}`;
    } finally {
        await connection.execute('DO RELEASE_LOCK(?)', [lockName]);
    }
};

const generateTodayAppointmentAuid = async (connection, date = new Date()) => {
    const datePart = formatDateForPublicId(date);
    const prefix = `${APPOINTMENT_AUID_PREFIX}${datePart}`;
    const lockName = `appointment_auid_${datePart}`;

    const [lockRows] = await connection.execute('SELECT GET_LOCK(?, 10) AS acquired_lock', [lockName]);

    if (!lockRows[0]?.acquired_lock) {
        throw new AppError('Unable to generate appointment ID right now. Please try again.', 503);
    }

    try {
        const [existingRows] = await connection.execute(
            `SELECT auid
             FROM tbl_appointments
             WHERE auid LIKE ?
             ORDER BY auid DESC
             LIMIT 1`,
            [`${prefix}%`]
        );

        const lastAuid = existingRows[0]?.auid || null;
        const lastSerial = lastAuid ? Number(String(lastAuid).slice(prefix.length)) : 0;
        const nextSerial = lastSerial + 1;

        if (nextSerial > 9999) {
            throw new AppError('Daily appointment ID generation limit exceeded', 409);
        }

        return `${prefix}${String(nextSerial).padStart(4, '0')}`;
    } finally {
        await connection.execute('DO RELEASE_LOCK(?)', [lockName]);
    }
};

const appointmentSelectColumns = `
    a.appointment_id, a.auid, a.fk_patient_id, a.parent_appointment_id, a.fk_branch_id, b.branch_name,
    a.fk_treatment_id, t.treatment_name, t.consultation_fee, a.fk_slot_id, s.slot_name,
    COALESCE(sto.override_start_time, s.start_time) AS start_time, COALESCE(sto.override_end_time, s.end_time) AS end_time, s.default_consult_minutes, a.current_token_number AS token_number, a.original_token_number, a.current_token_number,
    a.is_shifted, a.shift_reason, a.not_available_at, a.booked_by_type, a.booked_by_user_id,
    a.rescheduled_from_appointment_id, a.reschedule_reason,
    a.queue_status, a.planned_start_at, a.planned_end_at, a.live_estimated_start_at, a.live_estimated_end_at,
    a.actual_called_at, a.actual_started_at, a.actual_completed_at, a.last_queue_event_at,
    a.checked_in_at, a.arrival_sequence,
    a.appointment_date, a.symptoms, a.status, a.reception_status, a.reception_approved_at, a.reception_approved_by,
    a.consultation_payment_status, a.consultation_payment_settlement_type, a.consultation_bill_id, a.payment_collected_at, a.payment_collected_by,
    a.reception_rejected_at, a.reception_rejected_by, a.reception_rejection_reason,
    a.cancelled_at, a.cancelled_by_user_id, a.cancelled_by_role,
    a.cancel_reason, a.is_active, a.created_at, a.updated_at,
    v.oxygen_saturation, v.blood_pressure, v.patient_height, v.patient_weight,
    v.occupation, v.history_present_illness, v.history_past_illness, v.family_history, v.allergies_history, v.gynecological_history, v.personal_social_history, v.general_examination, v.systematic_examination, v.differential_diagnosis, v.follow_up, v.disease, v.mental_mind_status,
    ${getAppointmentPatientColumns()}
`;

const getAppointmentDetailsById = async (appointmentId) => {
    const rows = await query(
        `SELECT ${appointmentSelectColumns}
         FROM tbl_appointments a
         JOIN master_clinic_branches b ON b.id = a.fk_branch_id
         JOIN master_treatments t ON t.id = a.fk_treatment_id
         JOIN master_slots s ON s.id = a.fk_slot_id
         LEFT JOIN tbl_doctor_slot_time_overrides sto
           ON sto.fk_branch_id = a.fk_branch_id
          AND sto.fk_slot_id = a.fk_slot_id
          AND sto.appointment_date = a.appointment_date
          AND sto.status = 'ACTIVE'
         LEFT JOIN tbl_appointment_vitals v ON v.appointment_id = a.appointment_id
         ${getAppointmentPatientJoin()}
         WHERE a.appointment_id = ?
         LIMIT 1`,
        [appointmentId]
    );

    return decorateTokenFields(rows[0] || null);
};

const getPrescriptionDetailByConsultationId = async (consultationId) => {
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
            c.workflow_status,
            c.doctor_finalized_at,
            c.reception_notified_at,
            c.reception_approved_at,
            c.reception_approved_by,
            c.reception_rejected_at,
            c.reception_rejected_by,
            c.reception_rejection_reason,
            c.sent_to_medical_at,
            c.medical_processed_at,
            c.medical_processed_by,
            c.created_at,
            c.updated_at,
            a.auid,
            a.appointment_date,
            a.current_token_number AS token_number,
            a.original_token_number,
            a.current_token_number,
            a.status AS appointment_status,
            ${getAppointmentPatientColumns()},
            b.id AS branch_id,
            b.branch_name,
            t.id AS treatment_id,
            t.treatment_name,
            s.id AS slot_id,
            s.slot_name,
            COALESCE(sto.override_start_time, s.start_time) AS start_time,
            COALESCE(sto.override_end_time, s.end_time) AS end_time
         FROM tbl_consultations c
         JOIN tbl_appointments a ON a.appointment_id = c.appointment_id
         JOIN master_users d ON d.id = c.doctor_id
         ${getAppointmentPatientJoin()}
         JOIN master_clinic_branches b ON b.id = a.fk_branch_id
         JOIN master_treatments t ON t.id = a.fk_treatment_id
         JOIN master_slots s ON s.id = a.fk_slot_id
         LEFT JOIN tbl_doctor_slot_time_overrides sto
           ON sto.fk_branch_id = a.fk_branch_id
          AND sto.fk_slot_id = a.fk_slot_id
          AND sto.appointment_date = a.appointment_date
          AND sto.status = 'ACTIVE'
         WHERE c.id = ?
         LIMIT 1`,
        [consultationId]
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
            mppi.dispense_status,
            mppi.void_reason,
            mppi.voided_by,
            mppi.voided_at,
            mppi.version,
            md.id AS medication_dosage_id,
            md.dose_label,
            md.sort_order,
            md.times_per_day,
            md.balls_per_dose,
            md.instructions
         FROM tbl_consultation_medications cm
         LEFT JOIN tbl_medical_prescription_pricing mpp
           ON mpp.consultation_id = cm.consultation_id
         LEFT JOIN tbl_medical_prescription_pricing_items mppi
           ON mppi.pricing_id = mpp.id
          AND mppi.consultation_medication_id = cm.id
         LEFT JOIN tbl_medication_dosages md ON md.consultation_medication_id = cm.id
         WHERE cm.consultation_id = ?
         ORDER BY cm.id ASC, COALESCE(md.sort_order, 999) ASC, md.id ASC`,
        [consultationId]
    );

    const medicationMap = new Map();

    medicationRows.forEach((row) => {
        if (!medicationMap.has(row.consultation_medication_id)) {
            medicationMap.set(row.consultation_medication_id, projectDispensingStatus({
                consultation_medication_id: row.consultation_medication_id,
                medicine_type: row.medicine_type,
                medicine_value: row.medicine_value,
                remark: row.remark,
                added_by_role: row.added_by_role || 'DOCTOR',
                doses: [],
            }, row));
        }

        if (row.medication_dosage_id) {
            medicationMap.get(row.consultation_medication_id).doses.push({
                medication_dosage_id: row.medication_dosage_id,
                dose_label: row.dose_label,
                sort_order: row.sort_order,
                times_per_day: row.times_per_day,
                balls_per_dose: row.balls_per_dose,
                instructions: row.instructions,
            });
        }
    });

    const testRows = await query(
        `SELECT
            id AS consultation_test_id,
            test_name,
            amount
         FROM tbl_consultation_tests
         WHERE consultation_id = ?
         ORDER BY id ASC`,
        [consultationId]
    );

    return {
        ...decorateTokenFields(consultationRows[0], {
            slotNameField: 'slot_name',
            startTimeField: 'start_time',
        }),
        medications: Array.from(medicationMap.values()),
        tests: testRows,
    };
};

const getReceptionistFormData = asyncHandler(async (req, res) => {
    const branchFilter = req.query.branch_id !== undefined ? toPositiveInt(req.query.branch_id) : null;

    if (req.query.branch_id !== undefined && !branchFilter) {
        throw new AppError('branch_id must be a positive integer', 400);
    }

    const [branches, rawTreatments] = await Promise.all([
        query(
            `SELECT id, branch_name, address, contact_no
             FROM master_clinic_branches
             WHERE is_active = 1
             ORDER BY branch_name ASC`
        ),
        query(
            `SELECT id, treatment_code, treatment_name, description, estimated_duration_minutes, consultation_fee
             FROM master_treatments
             WHERE is_active = 1
             ORDER BY treatment_name ASC`
        ),
    ]);
    const followUpMeta = buildFollowUpMeta(rawTreatments);

    const slotParams = [];
    let slotSql = `SELECT id, fk_branch_id, slot_name, start_time, end_time, COALESCE(default_consult_minutes, 15) AS default_consult_minutes
                   FROM master_slots
                   WHERE is_active = 1`;

    if (branchFilter) {
        slotSql += ' AND fk_branch_id = ?';
        slotParams.push(branchFilter);
    }

    slotSql += ' ORDER BY start_time ASC';

    const slots = await query(slotSql, slotParams);

    return res.status(200).json({
        success: true,
        message: 'Receptionist form data fetched successfully',
        data: {
            branches,
            treatments: followUpMeta.treatments,
            slots,
            meta: {
                token_number_range: {
                    min: 1,
                    max: branchFilter ? getBranchMaxTokenNumber(branchFilter) : MAX_TOKEN_NUMBER,
                },
                booking_sources: ['SELF', 'RECEPTIONIST'],
                booking_for_options: Object.values(BOOKED_FOR_TYPES),
                statuses: ['Pending', 'Confirmed', 'Completed', 'Cancelled'],
                reception_statuses: ['PENDING_AT_RECEPTION', 'APPROVED_BY_RECEPTION', 'REJECTED_BY_RECEPTION'],
                follow_up_rules: followUpMeta.meta,
            },
        },
    });
});

const listReceptionistPatients = asyncHandler(async (req, res) => {
    const branchId = req.query.branch_id !== undefined ? toPositiveInt(req.query.branch_id) : null;
    const search = req.query.search ? String(req.query.search).trim() : null;
    const gender = req.query.gender ? String(req.query.gender).trim().toLowerCase() : null;
    const hasFamilyRaw = req.query.has_family !== undefined ? String(req.query.has_family).trim().toLowerCase() : null;
    const hasFamily =
        hasFamilyRaw === null || hasFamilyRaw === ''
            ? null
            : ['1', 'true', 'yes'].includes(hasFamilyRaw)
              ? true
              : ['0', 'false', 'no'].includes(hasFamilyRaw)
                ? false
                : null;
    const page = toPositiveInt(req.query.page) || 1;
    const requestedPageSize = toPositiveInt(req.query.page_size) || 20;
    const pageSize = Math.min(requestedPageSize, 100);
    const offset = (page - 1) * pageSize;

    if (hasFamilyRaw && hasFamily === null) {
        throw new AppError("has_family must be one of '1', '0', 'true' or 'false'", 400);
    }

    const conditions = [`u.is_active = 1`, `u.role = 'PAT'`];
    const params = [];
    const joinParams = [];

    if (req.query.branch_id !== undefined && !branchId) {
        throw new AppError('branch_id must be a positive integer', 400);
    }

    if (branchId) {
        conditions.push('EXISTS (SELECT 1 FROM tbl_appointments a_branch WHERE a_branch.fk_patient_id = u.id AND a_branch.fk_branch_id = ?)');
        params.push(branchId);
        joinParams.push(branchId);
    }

    if (search) {
        conditions.push('(u.full_name LIKE ? OR u.mobile_no LIKE ? OR u.uuid LIKE ? OR u.email LIKE ?)');
        params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
    }

    if (gender) {
        if (!validateGender(gender)) {
            throw new AppError("gender must be one of 'male', 'female' or 'other'", 400);
        }
        conditions.push('u.gender = ?');
        params.push(gender);
    }

    if (hasFamily === true) {
        conditions.push(
            `EXISTS (
                SELECT 1
                FROM tbl_patient_family_members fm_filter
                WHERE fm_filter.fk_primary_patient_id = u.id
                  AND fm_filter.is_active = 1
             )`
        );
    } else if (hasFamily === false) {
        conditions.push(
            `NOT EXISTS (
                SELECT 1
                FROM tbl_patient_family_members fm_filter
                WHERE fm_filter.fk_primary_patient_id = u.id
                  AND fm_filter.is_active = 1
             )`
        );
    }

    const whereClause = `WHERE ${conditions.join(' AND ')}`;

    const [countRows, rows] = await Promise.all([
        query(
            `SELECT COUNT(*) AS total
             FROM master_users u
             ${whereClause}`,
            params
        ),
        query(
            `SELECT
            u.id AS patient_id,
            u.uuid AS patient_uuid,
            u.full_name,
            u.age,
            u.gender,
            u.email,
            u.mobile_no,
            u.description,
            u.created_at,
            u.updated_at,
            (SELECT COUNT(*) FROM tbl_patient_family_members fm WHERE fm.fk_primary_patient_id = u.id AND fm.is_active = 1) AS active_family_members,
            (SELECT COUNT(*) FROM tbl_appointments a WHERE a.fk_patient_id = u.id ${branchId ? `AND a.fk_branch_id = ${branchId}` : ''} AND a.is_active = 1) AS total_appointments,
            (SELECT MAX(a.appointment_date) FROM tbl_appointments a WHERE a.fk_patient_id = u.id ${branchId ? `AND a.fk_branch_id = ${branchId}` : ''} AND a.is_active = 1) AS last_appointment_date
         FROM master_users u
         ${whereClause}
         ORDER BY u.full_name ASC
         LIMIT ${pageSize} OFFSET ${offset}`,
            params
        ),
    ]);

    const total = Number(countRows[0]?.total || 0);
    const totalPages = Math.max(1, Math.ceil(total / pageSize));

    const patientIds = rows.map((row) => Number(row.patient_id)).filter(Boolean);
    let familyMembersByPatientId = {};

    if (patientIds.length > 0) {
        const placeholders = patientIds.map(() => '?').join(', ');
        const familyRows = await query(
            `SELECT
                fm.id AS family_member_id,
                fm.fk_primary_patient_id,
                fm.full_name,
                fm.age,
                fm.gender,
                fm.relationship,
                fm.description,
                fm.is_active,
                fm.created_at,
                fm.updated_at
             FROM tbl_patient_family_members fm
             WHERE fm.fk_primary_patient_id IN (${placeholders})
               AND fm.is_active = 1
             ORDER BY fm.created_at ASC, fm.id ASC`,
            patientIds
        );

        familyMembersByPatientId = familyRows.reduce((acc, member) => {
            const key = Number(member.fk_primary_patient_id);
            if (!acc[key]) acc[key] = [];
            acc[key].push(member);
            return acc;
        }, {});
    }

    const data = rows.map((row) => ({
        ...row,
        family_members: familyMembersByPatientId[Number(row.patient_id)] || [],
    }));

    return res.status(200).json({
        success: true,
        message: 'Receptionist patients fetched successfully',
        data,
        meta: {
            branch_id: branchId,
            search,
            gender,
            has_family: hasFamily,
            page,
            page_size: pageSize,
            total,
            total_pages: totalPages,
        },
    });
});

const updateReceptionistPatient = asyncHandler(async (req, res) => {
    const patientId = toPositiveInt(req.params.patient_id);
    const familyMemberId = toPositiveInt(req.body?.family_member_id);
    const branchId = req.selectedBranchId || null;
    const fullName = req.body?.full_name !== undefined ? String(req.body.full_name).trim() : undefined;
    const mobileNo = req.body?.mobile_no !== undefined ? String(req.body.mobile_no).trim() : undefined;
    const gender = req.body?.gender !== undefined ? String(req.body.gender).trim().toLowerCase() : undefined;
    const age = req.body?.age !== undefined ? toPositiveInt(req.body.age) : undefined;
    const relationship =
        req.body?.relationship !== undefined ? String(req.body.relationship).trim() : undefined;

    if (!patientId) {
        throw new AppError('Valid patient_id is required', 400);
    }

    if (familyMemberId) {
        if (fullName === undefined && gender === undefined && age === undefined && relationship === undefined) {
            throw new AppError('At least one of full_name, gender, age or relationship is required', 400);
        }
    } else if (fullName === undefined && mobileNo === undefined && gender === undefined) {
        throw new AppError('At least one of full_name, mobile_no or gender is required', 400);
    }

    if (fullName !== undefined && (!fullName || fullName.length > 100)) {
        throw new AppError('full_name must be between 1 and 100 characters', 400);
    }

    if (!familyMemberId && mobileNo !== undefined && !validateMobile(mobileNo)) {
        throw new AppError('mobile_no must be 10 to 15 digits', 400);
    }

    if (gender !== undefined && !validateGender(gender)) {
        throw new AppError("gender must be one of 'male', 'female' or 'other'", 400);
    }

    if (age !== undefined && (age === null || age < 1 || age > 120)) {
        throw new AppError('age must be between 1 and 120', 400);
    }

    if (relationship !== undefined && (!relationship || relationship.length > 50)) {
        throw new AppError('relationship must be between 1 and 50 characters', 400);
    }

    const actorIp = getClientIp(req);
    const actorRole = req.user?.role_code || req.user?.role || null;
    const actorUserAgent = req.headers['user-agent'] || null;

    const result = await withTransaction(async (connection) => {
        const [patientRows] = await connection.execute(
            `SELECT id, uuid, full_name, mobile_no, gender, age, role, is_active, updated_at
             FROM master_users
             WHERE id = ?
             LIMIT 1
             FOR UPDATE`,
            [patientId]
        );

        if (patientRows.length === 0) {
            throw new AppError('Patient not found', 404);
        }

        const patient = patientRows[0];

        if (String(patient.role || '').toUpperCase() !== PATIENT_ROLE) {
            throw new AppError('Selected record is not a patient account', 409);
        }

        if (Number(patient.is_active) !== 1) {
            throw new AppError('Selected patient is inactive', 409);
        }

        if (branchId) {
            const [branchRows] = await connection.execute(
                `SELECT appointment_id
                 FROM tbl_appointments
                 WHERE fk_patient_id = ?
                   AND fk_branch_id = ?
                 LIMIT 1`,
                [patientId, branchId]
            );

            if (branchRows.length === 0) {
                throw new AppError('Patient is not available in the selected branch', 403);
            }
        }

        if (familyMemberId) {
            const [fmRows] = await connection.execute(
                `SELECT id, full_name, age, gender, relationship, description, is_active
                 FROM tbl_patient_family_members
                 WHERE id = ?
                   AND fk_primary_patient_id = ?
                 LIMIT 1
                 FOR UPDATE`,
                [familyMemberId, patientId]
            );

            if (fmRows.length === 0) {
                throw new AppError('Family member not found', 404);
            }

            const fm = fmRows[0];
            if (Number(fm.is_active) !== 1) {
                throw new AppError('Selected family member is inactive', 409);
            }

            const fmChangedFields = [];
            const fmOldValues = {};
            const fmNewValues = {};
            const fmRequestedValues = {
                full_name: fullName,
                gender,
                age,
                relationship,
            };

            for (const [field, value] of Object.entries(fmRequestedValues)) {
                if (value !== undefined && String(value) !== String(fm[field] ?? '')) {
                    fmChangedFields.push(field);
                    fmOldValues[field] = fm[field];
                    fmNewValues[field] = value;
                }
            }

            if (fmChangedFields.length === 0) {
                throw new AppError('No family member details were changed', 400);
            }

            const fmUpdateParts = [];
            const fmUpdateValues = [];
            for (const field of ['full_name', 'gender', 'age', 'relationship']) {
                if (fmNewValues[field] !== undefined) {
                    fmUpdateParts.push(`${field} = ?`);
                    fmUpdateValues.push(fmNewValues[field]);
                }
            }

            fmUpdateParts.push('updated_by = ?', 'updated_ip = ?');
            fmUpdateValues.push(req.user.id, actorIp, familyMemberId, patientId);

            await connection.execute(
                `UPDATE tbl_patient_family_members
                 SET ${fmUpdateParts.join(', ')}
                 WHERE id = ?
                   AND fk_primary_patient_id = ?`,
                fmUpdateValues
            );

            await connection.execute(
                `INSERT INTO log_user_profile_updates
                 (user_id, changed_by_user_id, changed_by_role, ip_address, user_agent, changed_fields_json, old_values_json, new_values_json)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    patientId,
                    req.user.id,
                    actorRole,
                    actorIp,
                    actorUserAgent,
                    JSON.stringify(fmChangedFields.map((f) => `family_member.${f}`)),
                    JSON.stringify(fmOldValues),
                    JSON.stringify(fmNewValues),
                ]
            );

            return {
                patient: {
                    patient_id: patientId,
                    patient_uuid: patient.uuid,
                    family_member_id: familyMemberId,
                    full_name: fmNewValues.full_name ?? fm.full_name,
                    age: fmNewValues.age ?? fm.age,
                    gender: fmNewValues.gender ?? fm.gender,
                    relationship: fmNewValues.relationship ?? fm.relationship,
                    mobile_no: patient.mobile_no,
                },
                changed_fields: fmChangedFields,
                entity_type: 'FAMILY_MEMBER',
            };
        }

        if (mobileNo !== undefined && mobileNo !== patient.mobile_no) {
            const [duplicateRows] = await connection.execute(
                `SELECT id
                 FROM master_users
                 WHERE mobile_no = ?
                   AND id <> ?
                 LIMIT 1`,
                [mobileNo, patientId]
            );

            if (duplicateRows.length > 0) {
                throw new AppError('Mobile number already in use by another user', 409);
            }
        }

        const oldValues = {};
        const newValues = {};
        const changedFields = [];
        const requestedValues = {
            full_name: fullName,
            mobile_no: mobileNo,
            gender,
        };

        for (const [field, value] of Object.entries(requestedValues)) {
            if (value !== undefined && value !== patient[field]) {
                changedFields.push(field);
                oldValues[field] = patient[field];
                newValues[field] = value;
            }
        }

        if (changedFields.length === 0) {
            throw new AppError('No patient details were changed', 400);
        }

        const updateParts = changedFields.map((field) => `${field} = ?`);
        const updateValues = changedFields.map((field) => newValues[field]);
        updateParts.push('updated_by = ?', 'updated_ip = ?');
        updateValues.push(req.user.id, actorIp, patientId);

        await connection.execute(
            `UPDATE master_users
             SET ${updateParts.join(', ')}
             WHERE id = ?`,
            updateValues
        );

        await connection.execute(
            `INSERT INTO log_user_profile_updates
             (user_id, changed_by_user_id, changed_by_role, ip_address, user_agent, changed_fields_json, old_values_json, new_values_json)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                patientId,
                req.user.id,
                actorRole,
                actorIp,
                actorUserAgent,
                JSON.stringify(changedFields),
                JSON.stringify(oldValues),
                JSON.stringify(newValues),
            ]
        );

        const [updatedRows] = await connection.execute(
            `SELECT id AS patient_id, uuid AS patient_uuid, full_name, age, gender, email, mobile_no,
                    description, created_at, updated_at
             FROM master_users
             WHERE id = ?
             LIMIT 1`,
            [patientId]
        );

        return {
            patient: updatedRows[0],
            changed_fields: changedFields,
            entity_type: 'SELF',
        };
    });

    return res.status(200).json({
        success: true,
        message: familyMemberId
            ? 'Family member details updated successfully'
            : 'Patient details updated successfully',
        data: result,
    });
});

const listReceptionistPatientUpdateHistory = asyncHandler(async (req, res) => {
    const patientId = toPositiveInt(req.params.patient_id);
    const branchId = req.selectedBranchId || null;

    if (!patientId) {
        throw new AppError('Valid patient_id is required', 400);
    }

    const patientRows = await query(
        `SELECT p.id, p.role, p.is_active
         FROM master_users p
         WHERE p.id = ?
           ${branchId ? `AND EXISTS (
             SELECT 1
             FROM tbl_appointments a
             WHERE a.fk_patient_id = p.id
               AND a.fk_branch_id = ?
           )` : ''}
         LIMIT 1`,
        branchId ? [patientId, branchId] : [patientId]
    );

    if (patientRows.length === 0) {
        throw new AppError('Patient not found in the selected branch', 404);
    }

    if (String(patientRows[0].role || '').toUpperCase() !== PATIENT_ROLE) {
        throw new AppError('Selected record is not a patient account', 409);
    }

    const historyRows = await query(
        `SELECT
            l.id,
            l.changed_by_user_id,
            actor.full_name AS changed_by_name,
            l.changed_by_role,
            l.ip_address,
            l.changed_fields_json,
            l.old_values_json,
            l.new_values_json,
            l.created_at
         FROM log_user_profile_updates l
         LEFT JOIN master_users actor ON actor.id = l.changed_by_user_id
         WHERE l.user_id = ?
         ORDER BY l.created_at DESC, l.id DESC`,
        [patientId]
    );

    const history = historyRows.map((row) => ({
        ...row,
        changed_fields: parseJsonColumn(row.changed_fields_json, []),
        old_values: parseJsonColumn(row.old_values_json, {}),
        new_values: parseJsonColumn(row.new_values_json, {}),
        changed_fields_json: undefined,
        old_values_json: undefined,
        new_values_json: undefined,
    }));

    return res.status(200).json({
        success: true,
        message: 'Patient update history fetched successfully',
        data: history,
        meta: {
            patient_id: patientId,
            total: history.length,
        },
    });
});

const getReceptionistPatientDetail = asyncHandler(async (req, res) => {
    const patientId = toPositiveInt(req.params.patient_id);
    const branchId = req.selectedBranchId || null;

    if (!patientId) {
        throw new AppError('Valid patient_id is required', 400);
    }

    const patientRows = await query(
        `SELECT
            p.id AS patient_id,
            p.uuid AS patient_uuid,
            p.full_name,
            p.age,
            p.gender,
            p.email,
            p.mobile_no,
            p.description,
            p.is_active,
            p.created_at,
            p.updated_at
         FROM master_users p
         WHERE p.id = ?
         LIMIT 1`,
        [patientId]
    );

    if (patientRows.length === 0) {
        throw new AppError('Patient not found', 404);
    }

    const [summaryRows, recentAppointments, recentConsultations, familyMembers] = await Promise.all([
        query(
            `SELECT
                COUNT(*) AS total_appointments,
                SUM(CASE WHEN a.status = 'Completed' THEN 1 ELSE 0 END) AS completed_appointments,
                SUM(CASE WHEN a.status IN ('Pending', 'Confirmed') THEN 1 ELSE 0 END) AS active_appointments,
                MAX(a.appointment_date) AS last_appointment_date
             FROM tbl_appointments a
             WHERE a.fk_patient_id = ?
               ${branchId ? 'AND a.fk_branch_id = ?' : ''}`,
            branchId ? [patientId, branchId] : [patientId]
        ),
        query(
            `SELECT
                a.appointment_id,
                a.auid,
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
                a.appointment_date,
                a.booked_by_type,
                a.booked_for_type,
                a.fk_patient_family_member_id,
                fm.relationship AS family_member_relationship,
                COALESCE(fm.full_name, p.full_name) AS patient_full_name,
                a.status,
                a.is_active,
                a.created_at
             FROM tbl_appointments a
             JOIN master_users p ON p.id = a.fk_patient_id
             LEFT JOIN tbl_patient_family_members fm
               ON fm.id = a.fk_patient_family_member_id
             JOIN master_clinic_branches b ON b.id = a.fk_branch_id
             JOIN master_treatments t ON t.id = a.fk_treatment_id
             JOIN master_slots s ON s.id = a.fk_slot_id
             LEFT JOIN tbl_doctor_slot_time_overrides sto
               ON sto.fk_branch_id = a.fk_branch_id
              AND sto.fk_slot_id = a.fk_slot_id
              AND sto.appointment_date = a.appointment_date
              AND sto.status = 'ACTIVE'
             WHERE a.fk_patient_id = ?
               ${branchId ? 'AND a.fk_branch_id = ?' : ''}
             ORDER BY a.appointment_date DESC, a.created_at DESC
             LIMIT 10`,
            branchId ? [patientId, branchId] : [patientId]
        ),
        query(
            `SELECT
                c.id AS consultation_id,
                c.appointment_id,
                c.workflow_status,
                c.medication_duration_days,
                c.created_at,
                c.updated_at,
                d.full_name AS doctor_name,
                COALESCE(fm.full_name, p.full_name) AS patient_full_name,
                fm.relationship AS family_member_relationship
             FROM tbl_consultations c
             JOIN tbl_appointments a ON a.appointment_id = c.appointment_id
             JOIN master_users d ON d.id = c.doctor_id
             JOIN master_users p ON p.id = a.fk_patient_id
             LEFT JOIN tbl_patient_family_members fm
               ON fm.id = a.fk_patient_family_member_id
             WHERE a.fk_patient_id = ?
               ${branchId ? 'AND a.fk_branch_id = ?' : ''}
             ORDER BY c.created_at DESC
             LIMIT 10`,
            branchId ? [patientId, branchId] : [patientId]
        ),
        query(
            `SELECT
                fm.id AS family_member_id,
                fm.full_name,
                fm.age,
                fm.gender,
                fm.relationship,
                fm.description,
                fm.is_active,
                fm.created_at,
                fm.updated_at
             FROM tbl_patient_family_members fm
             WHERE fm.fk_primary_patient_id = ?
             ORDER BY fm.is_active DESC, fm.created_at ASC, fm.id ASC`,
            [patientId]
        ),
    ]);

    return res.status(200).json({
        success: true,
        message: 'Receptionist patient detail fetched successfully',
        data: {
            patient: patientRows[0],
            summary: summaryRows[0] || {
                total_appointments: 0,
                completed_appointments: 0,
                active_appointments: 0,
                last_appointment_date: null,
            },
            recent_appointments: recentAppointments,
            recent_consultations: recentConsultations,
            family_members: familyMembers,
            branch_scope: {
                branch_id: branchId,
            },
        },
    });
});

const createReceptionistPatientFamilyMember = asyncHandler(async (req, res) => {
    const patientId = toPositiveInt(req.params.patient_id);

    if (!patientId) {
        throw new AppError('Valid patient_id is required', 400);
    }

    const payload = normalizeFamilyMemberPayload(req.body);
    const createdIp = getClientIp(req);

    const familyMemberId = await withTransaction(async (connection) => {
        const [patientRows] = await connection.execute(
            `SELECT id, role, is_active
             FROM master_users
             WHERE id = ?
             LIMIT 1
             FOR UPDATE`,
            [patientId]
        );

        if (patientRows.length === 0) {
            throw new AppError('Patient not found', 404);
        }

        if (String(patientRows[0].role || '').toUpperCase() !== PATIENT_ROLE) {
            throw new AppError('Selected record is not a patient account', 409);
        }

        if (Number(patientRows[0].is_active) !== 1) {
            throw new AppError('Selected patient is inactive', 409);
        }

        const [activeRows] = await connection.execute(
            `SELECT COUNT(*) AS active_count
             FROM tbl_patient_family_members
             WHERE fk_primary_patient_id = ?
               AND is_active = 1
             FOR UPDATE`,
            [patientId]
        );

        if (Number(activeRows[0]?.active_count || 0) >= MAX_ACTIVE_FAMILY_MEMBERS) {
            throw new AppError(`Maximum ${MAX_ACTIVE_FAMILY_MEMBERS} active family members are allowed per patient account`, 409);
        }

        const [insertResult] = await connection.execute(
            `INSERT INTO tbl_patient_family_members
             (fk_primary_patient_id, full_name, age, gender, relationship, description, is_active, created_by, updated_by, created_ip, updated_ip)
             VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
            [
                patientId,
                payload.full_name,
                payload.age,
                payload.gender,
                payload.relationship,
                payload.description,
                req.user.id,
                req.user.id,
                createdIp,
                createdIp,
            ]
        );

        return insertResult.insertId;
    });

    const rows = await query(
        `SELECT
            fm.id AS family_member_id,
            fm.fk_primary_patient_id,
            fm.full_name,
            fm.age,
            fm.gender,
            fm.relationship,
            fm.description,
            fm.is_active,
            fm.created_at,
            fm.updated_at
         FROM tbl_patient_family_members fm
         WHERE fm.id = ?
           AND fm.fk_primary_patient_id = ?
         LIMIT 1`,
        [familyMemberId, patientId]
    );

    return res.status(201).json({
        success: true,
        message: 'Family member created successfully',
        data: rows[0] || null,
    });
});

const createAppointmentByReceptionist = asyncHandler(async (req, res) => {
    const {
        fk_patient_id,
        patient,
        fk_branch_id,
        fk_treatment_id,
        fk_slot_id,
        appointment_date,
        symptoms = null,
        token_number = null,
        booking_for = BOOKED_FOR_TYPES.SELF,
        booked_for_type = undefined,
        fk_patient_family_member_id = null,
        parent_appointment_id = null,
    } = req.body || {};

    const patientId = toPositiveInt(fk_patient_id);
    const branchId = toPositiveInt(fk_branch_id);
    const treatmentId = toPositiveInt(fk_treatment_id);
    const slotId = toPositiveInt(fk_slot_id);
    const newPatientFullName = String(patient?.full_name || '').trim();
    const newPatientMobileNo = String(patient?.mobile_no || '').trim();
    const newPatientAge = patient?.age;
    const newPatientGender = String(patient?.gender || '').trim().toLowerCase();
    const hasNewPatientPayload = Boolean(
        newPatientFullName || newPatientMobileNo || newPatientAge !== undefined || newPatientGender
    );

    if ((!patientId && !hasNewPatientPayload) || !branchId || !treatmentId || !slotId || !appointment_date) {
        throw new AppError('Existing fk_patient_id or patient details are required along with branch, treatment, slot and appointment date', 400);
    }

    if (patientId && hasNewPatientPayload) {
        throw new AppError('Provide either fk_patient_id or patient details, not both', 400);
    }

    if (!patientId && hasNewPatientPayload) {
        const parsedAge = Number(newPatientAge);

        if (!newPatientFullName || !newPatientMobileNo || newPatientAge === undefined || !newPatientGender) {
            throw new AppError('patient.full_name, patient.mobile_no, patient.age and patient.gender are required for new patient booking', 400);
        }

        if (!validateMobile(newPatientMobileNo)) {
            throw new AppError('patient.mobile_no must be a valid mobile number', 400);
        }

        if (!Number.isInteger(parsedAge) || parsedAge < 1 || parsedAge > 120) {
            throw new AppError('patient.age must be a valid number between 1 and 120', 400);
        }

        if (!validateGender(newPatientGender)) {
            throw new AppError("patient.gender must be one of: 'male', 'female', 'other'", 400);
        }
    }

    if (!isValidDateString(appointment_date)) {
        throw new AppError('appointment_date must be in YYYY-MM-DD format', 400);
    }

    let tokenNumber = null;
    if (token_number !== null && token_number !== undefined && token_number !== '') {
        tokenNumber = toPositiveInt(token_number);
        if (!tokenNumber || tokenNumber < 1) {
            throw new AppError('token_number must be a positive integer', 400);
        }
    }

    const bookedForType = normalizeBookedForType(booked_for_type || booking_for);
    if (!bookedForType) {
        throw new AppError('booking_for must be SELF or FAMILY_MEMBER', 400);
    }

    let familyMemberId = null;
    if (bookedForType === BOOKED_FOR_TYPES.FAMILY_MEMBER) {
        familyMemberId = toPositiveInt(fk_patient_family_member_id);
        if (!familyMemberId) {
            throw new AppError('fk_patient_family_member_id is required when booking_for is FAMILY_MEMBER', 400);
        }
    }

    let parentAppointmentId = null;
    if (parent_appointment_id !== null && parent_appointment_id !== undefined && parent_appointment_id !== '') {
        parentAppointmentId = toPositiveInt(parent_appointment_id);
        if (!parentAppointmentId) {
            throw new AppError('parent_appointment_id must be a positive integer', 400);
        }
    }

    const createdIp = getClientIp(req);

    const result = await withTransaction(async (connection) => {
        let resolvedPatientId = patientId;
        let patientRows = [];

        if (resolvedPatientId) {
            const [existingPatientRows] = await connection.execute(
                `SELECT id, role, is_active
                 FROM master_users
                 WHERE id = ?
                 LIMIT 1`,
                [resolvedPatientId]
            );
            patientRows = existingPatientRows;
        } else {
            const [matchedPatientRows] = await connection.execute(
                `SELECT id, role, is_active
                 FROM master_users
                 WHERE mobile_no = ?
                 LIMIT 1
                 FOR UPDATE`,
                [newPatientMobileNo]
            );

            if (matchedPatientRows.length > 0) {
                patientRows = matchedPatientRows;
                resolvedPatientId = matchedPatientRows[0].id;
            } else {
                const generatedPatientUuid = await generateTodayPatientUuid(connection);
                const generatedPasswordHash = await bcrypt.hash(randomUUID(), 10);

                const [insertPatientResult] = await connection.execute(
                    `INSERT INTO master_users
                     (uuid, full_name, age, gender, email, description, mobile_no, password, role, is_active, created_by, updated_by, created_ip, updated_ip)
                     VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, ?, 1, ?, ?, ?, ?)`,
                    [
                        generatedPatientUuid,
                        newPatientFullName,
                        Number(newPatientAge),
                        newPatientGender,
                        newPatientMobileNo,
                        generatedPasswordHash,
                        PATIENT_ROLE,
                        req.user.id,
                        req.user.id,
                        createdIp,
                        createdIp,
                    ]
                );

                resolvedPatientId = insertPatientResult.insertId;
                patientRows = [{
                    id: resolvedPatientId,
                    role: PATIENT_ROLE,
                    is_active: 1,
                }];
            }
        }

        if (bookedForType === BOOKED_FOR_TYPES.FAMILY_MEMBER) {
            if (!resolvedPatientId) {
                throw new AppError('Family member booking requires an existing patient account', 400);
            }

            const [familyMemberRows] = await connection.execute(
                `SELECT id
                 FROM tbl_patient_family_members
                 WHERE id = ?
                   AND fk_primary_patient_id = ?
                   AND is_active = 1
                 LIMIT 1`,
                [familyMemberId, resolvedPatientId]
            );

            if (familyMemberRows.length === 0) {
                throw new AppError('Selected family member not found for the selected patient account', 404);
            }
        }
        const [branchRows] = await connection.execute(
            'SELECT id FROM master_clinic_branches WHERE id = ? AND is_active = 1 LIMIT 1',
            [branchId]
        );
        const [treatmentRows] = await connection.execute(
            'SELECT id, treatment_code, treatment_name, consultation_fee FROM master_treatments WHERE id = ? AND is_active = 1 LIMIT 1',
            [treatmentId]
        );
        const [slotRows] = await connection.execute(
            'SELECT id, fk_branch_id, start_time, end_time, COALESCE(default_consult_minutes, 15) AS default_consult_minutes FROM master_slots WHERE id = ? AND is_active = 1 LIMIT 1',
            [slotId]
        );

        if (patientRows.length === 0) {
            throw new AppError('Selected patient not found', 404);
        }

        if (String(patientRows[0].role || '').toUpperCase() !== PATIENT_ROLE) {
            throw new AppError('Selected patient record is not a patient account', 409);
        }

        if (Number(patientRows[0].is_active) !== 1) {
            throw new AppError('Selected patient is inactive', 409);
        }

        if (branchRows.length === 0) {
            throw new AppError('Selected branch not found or inactive', 404);
        }

        if (treatmentRows.length === 0) {
            throw new AppError('Selected treatment not found or inactive', 404);
        }

        if (slotRows.length === 0) {
            throw new AppError('Selected slot not found or inactive', 404);
        }

        if (Number(slotRows[0].fk_branch_id) !== branchId) {
            throw new AppError('Selected slot does not belong to the selected branch', 400);
        }

        const treatment = await getTreatmentById(connection, treatmentId);
        const visitTypeCode = getVisitTypeCode({
            treatmentId,
            treatmentName: treatment?.treatment_name,
            treatmentCode: treatment?.treatment_code,
        });

        await assertBranchDoctorAvailableForBooking({
            branchId,
            appointmentDate: appointment_date,
            connection,
        });

        const effectiveTiming = await resolveEffectiveSlotTiming({
            executor: connection,
            branchId,
            slotId,
            appointmentDate: appointment_date,
        });
        validateSlotBookingCutoff({
            appointmentDate: appointment_date,
            slotEndTime: effectiveTiming.effectiveEndTime,
        });

        const conflictCondition = buildBookingConflictCondition({
            bookedForType,
            primaryPatientId: resolvedPatientId,
            familyMemberId,
        });

        const [conflictingPatientAppointments] = await connection.execute(
            `SELECT appointment_id
             FROM tbl_appointments
             WHERE ${conflictCondition.sql}
               AND appointment_date = ?
               AND is_active = 1
               AND status IN ('Pending', 'Confirmed')
               AND COALESCE(reception_status, '') <> 'REJECTED_BY_RECEPTION'
               AND COALESCE(queue_status, '') <> 'CANCELLED'
             FOR UPDATE`,
            [...conflictCondition.params, appointment_date]
        );

        if (conflictingPatientAppointments.length > 0) {
            throw new AppError('This patient already has an unresolved active appointment for the selected date', 409);
        }

        let eligiblePendingFollowUp = null;
        let linkedParentAppointmentId = parentAppointmentId;
        if (isFollowUpBookingVisitType(visitTypeCode)) {
            if (parentAppointmentId) {
                eligiblePendingFollowUp = await lockEligiblePendingFollowUp({
                    connection,
                    parentAppointmentId,
                    patientId: resolvedPatientId,
                    familyMemberId,
                });

                if (!eligiblePendingFollowUp) {
                    throw new AppError('Contact with clinic reception for booking appointment.', 409);
                }
            } else {
                linkedParentAppointmentId = null;
            }
        }

        const [bookedAppointments] = await connection.execute(
            `SELECT token_number, current_token_number
             FROM tbl_appointments
             WHERE fk_branch_id = ?
               AND fk_slot_id = ?
               AND appointment_date = ?
               AND is_active = 1
               AND status <> 'Cancelled'
               AND COALESCE(reception_status, '') <> 'REJECTED_BY_RECEPTION'
               AND COALESCE(queue_status, '') <> 'CANCELLED'
             FOR UPDATE`,
            [branchId, slotId, appointment_date]
        );

        const bookedFixedTokenNumbers = new Set(
            bookedAppointments
                .map((appointment) => Number(appointment.token_number))
                .filter((value) => Number.isInteger(value) && value > 0)
        );
        const bookedCurrentTokenNumbers = new Set(
            bookedAppointments
                .map((appointment) => Number(appointment.current_token_number))
                .filter((value) => Number.isInteger(value) && value > 0)
        );

        const slotTokenPlate = supportsTokenPlateVisitType(visitTypeCode)
            ? await buildEffectiveSlotTokenPlate({
                executor: connection,
                branchId,
                slotId,
                appointmentDate: appointment_date,
                slotStartTime: slotRows[0].start_time,
            })
            : null;

        const assignedTokens = assignAppointmentTokenNumbers({
            requestedTokenNumber: tokenNumber,
            bookedFixedTokenNumbers,
            bookedCurrentTokenNumbers,
            visitTypeCode: supportsTokenPlateVisitType(visitTypeCode) ? visitTypeCode : null,
            slotTokenPlate,
        });
        const assignedPlateToken = getPlateTokenByNumber(slotTokenPlate, assignedTokens.tokenNumber);
        const appointmentAuid = await generateTodayAppointmentAuid(connection);
        const bookingSubjectKey = getBookingSubjectKey({
            bookedForType,
            primaryPatientId: resolvedPatientId,
            familyMemberId,
        });

        const [insertResult] = await connection.execute(
            `INSERT INTO tbl_appointments
             (auid, fk_patient_id, fk_patient_family_member_id, parent_appointment_id, booked_for_type, booking_subject_key, fk_branch_id, fk_treatment_id, assigned_visit_type_code, assigned_slot_duration_minutes, fk_slot_id, token_number, original_token_number, current_token_number, appointment_date, symptoms, status, reception_status, booked_by_type, booked_by_user_id, queue_status, last_queue_event_at, is_active, created_by, updated_by, created_ip, updated_ip)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Pending', 'PENDING_AT_RECEPTION', 'RECEPTIONIST', ?, ?, NOW(), 1, ?, ?, ?, ?)`,
            [
                appointmentAuid,
                resolvedPatientId,
                familyMemberId,
                linkedParentAppointmentId,
                bookedForType,
                bookingSubjectKey,
                branchId,
                treatmentId,
                assignedPlateToken?.visit_type_code || null,
                assignedPlateToken?.duration_minutes || null,
                slotId,
                assignedTokens.tokenNumber,
                assignedTokens.originalTokenNumber,
                assignedTokens.currentTokenNumber,
                appointment_date,
                symptoms ? String(symptoms).trim() : null,
                req.user.id,
                QUEUE_STATUS.BOOKED,
                req.user.id,
                req.user.id,
                createdIp,
                createdIp,
            ]
        );

        await createConsultationBillForAppointment({
            connection,
            appointmentId: insertResult.insertId,
            patientId: resolvedPatientId,
            branchId,
            treatmentId,
            paymentSettlementType: isFollowUpBookingVisitType(visitTypeCode)
                ? PAYMENT_SETTLEMENT_TYPES.FOLLOW_UP
                : PAYMENT_SETTLEMENT_TYPES.COLLECTED,
            actorUserId: req.user.id,
        });

        await recalculateQueuePlan(connection, {
            branchId,
            slotId,
            appointmentDate: appointment_date,
            actorUserId: req.user.id,
            actorIp: createdIp,
        });

        await logQueueEvent(connection, {
            appointmentId: insertResult.insertId,
            branchId,
            slotId,
            appointmentDate: appointment_date,
            tokenNumber: assignedTokens.currentTokenNumber,
            eventType: 'APPOINTMENT_CREATED',
            newQueueStatus: QUEUE_STATUS.BOOKED,
            createdBy: req.user.id,
            meta: {
                booked_by_type: 'RECEPTIONIST',
                booked_for_type: bookedForType,
                fk_patient_family_member_id: familyMemberId,
                parent_appointment_id: linkedParentAppointmentId,
            },
        });

        if (eligiblePendingFollowUp?.id) {
            await markPendingFollowUpBooked({
                connection,
                pendingFollowupId: Number(eligiblePendingFollowUp.id),
            });
        }

        return insertResult.insertId;
    });

    const appointment = await getAppointmentDetailsById(result);

    await emitLiveQueueEvent({
        branchId,
        slotId,
        appointmentDate: appointment_date,
        eventName: 'queue-updated',
        reason: 'APPOINTMENT_CREATED',
        appointmentId: result,
    });

    emitToRole('DOC', 'doctor.appointments.updated', {
        reason: 'APPOINTMENT_CREATED',
        source: 'RECEPTIONIST_BOOKING',
        appointment,
    });

    return res.status(201).json({
        success: true,
        message: 'Appointment booked by receptionist successfully',
        data: appointment,
    });
});

const listReceptionistAppointments = asyncHandler(async (req, res) => {
    await ensureVitalsColumnsExist();
    const branchId = req.query.branch_id !== undefined ? toPositiveInt(req.query.branch_id) : null;
    const slotId = req.query.slot_id !== undefined ? toPositiveInt(req.query.slot_id) : null;
    const appointmentDate = req.query.appointment_date ? String(req.query.appointment_date).trim() : null;
    const patientSearch = req.query.patient_search ? String(req.query.patient_search).trim() : null;
    const bookedByType = req.query.booked_by_type ? String(req.query.booked_by_type).trim().toUpperCase() : null;
    const bookedForType = req.query.booked_for_type ? String(req.query.booked_for_type).trim().toUpperCase() : null;
    const receptionStatus = req.query.reception_status ? String(req.query.reception_status).trim().toUpperCase() : null;

    if (req.query.branch_id !== undefined && !branchId) {
        throw new AppError('branch_id must be a positive integer', 400);
    }
    if (req.query.slot_id !== undefined && !slotId) {
        throw new AppError('slot_id must be a positive integer', 400);
    }
    if (appointmentDate && !isValidDateString(appointmentDate)) {
        throw new AppError('appointment_date must be in YYYY-MM-DD format', 400);
    }
    if (bookedByType && !['SELF', 'RECEPTIONIST'].includes(bookedByType)) {
        throw new AppError('booked_by_type must be SELF or RECEPTIONIST', 400);
    }
    if (bookedForType && !Object.values(BOOKED_FOR_TYPES).includes(bookedForType)) {
        throw new AppError('booked_for_type must be SELF or FAMILY_MEMBER', 400);
    }
    if (receptionStatus && !['PENDING_AT_RECEPTION', 'APPROVED_BY_RECEPTION', 'REJECTED_BY_RECEPTION'].includes(receptionStatus)) {
        throw new AppError('reception_status must be PENDING_AT_RECEPTION, APPROVED_BY_RECEPTION or REJECTED_BY_RECEPTION', 400);
    }

    const conditions = [];
    const params = [];

    conditions.push('a.is_active = 1');
    conditions.push(`a.status <> 'Cancelled'`);

    if (branchId) {
        conditions.push('a.fk_branch_id = ?');
        params.push(branchId);
    }
    if (slotId) {
        conditions.push('a.fk_slot_id = ?');
        params.push(slotId);
    }
    if (appointmentDate) {
        conditions.push('a.appointment_date = ?');
        params.push(appointmentDate);
    }
    if (patientSearch) {
        conditions.push('(COALESCE(fm.full_name, p.full_name) LIKE ? OR p.full_name LIKE ? OR p.mobile_no LIKE ? OR p.uuid LIKE ?)');
        params.push(`%${patientSearch}%`, `%${patientSearch}%`, `%${patientSearch}%`, `%${patientSearch}%`);
    }
    if (bookedForType) {
        conditions.push('a.booked_for_type = ?');
        params.push(bookedForType);
    }
    if (bookedByType) {
        conditions.push('a.booked_by_type = ?');
        params.push(bookedByType);
    }
    if (receptionStatus) {
        conditions.push('a.reception_status = ?');
        params.push(receptionStatus);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const rows = await query(
        `SELECT ${appointmentSelectColumns}
         FROM tbl_appointments a
         JOIN master_clinic_branches b ON b.id = a.fk_branch_id
         JOIN master_treatments t ON t.id = a.fk_treatment_id
         JOIN master_slots s ON s.id = a.fk_slot_id
         LEFT JOIN tbl_doctor_slot_time_overrides sto
           ON sto.fk_branch_id = a.fk_branch_id
          AND sto.fk_slot_id = a.fk_slot_id
          AND sto.appointment_date = a.appointment_date
          AND sto.status = 'ACTIVE'
         LEFT JOIN tbl_appointment_vitals v ON v.appointment_id = a.appointment_id
         ${getAppointmentPatientJoin()}
         ${whereClause}
         ORDER BY a.appointment_date ASC, a.current_token_number ASC, a.created_at ASC`,
        params
    );
    const queueGroups = rows.reduce((groups, appointment) => {
        if (!appointment?.appointment_date || !appointment?.fk_branch_id || !appointment?.fk_slot_id) {
            return groups;
        }

        groups.set(
            [
                normalizeQueueDateKey(appointment.appointment_date),
                Number(appointment.fk_branch_id),
                Number(appointment.fk_slot_id),
            ].join(':'),
            {
                appointment_date: appointment.appointment_date,
                fk_branch_id: Number(appointment.fk_branch_id),
                fk_slot_id: Number(appointment.fk_slot_id),
            }
        );

        return groups;
    }, new Map());
    let queueSessions = [];
    let queueTimelineRows = [];
    const protectedWindowAppointmentIdsByGroup = new Map();

    if (queueGroups.size > 0) {
        const groupConditions = [];
        const groupParams = [];

        for (const group of queueGroups.values()) {
            groupConditions.push('(appointment_date = ? AND fk_branch_id = ? AND fk_slot_id = ?)');
            groupParams.push(group.appointment_date, group.fk_branch_id, group.fk_slot_id);
        }

        queueSessions = await query(
            `SELECT fk_branch_id, fk_slot_id, appointment_date, session_status, current_appointment_id
             FROM tbl_live_queue_sessions
             WHERE ${groupConditions.join(' OR ')}`,
            groupParams
        );

        queueTimelineRows = await query(
            `SELECT
                appointment_id,
                fk_branch_id,
                fk_slot_id,
                appointment_date,
                current_token_number AS token_number,
                original_token_number,
                current_token_number,
                queue_status,
                checked_in_at,
                arrival_sequence,
                actual_called_at,
                actual_started_at,
                actual_completed_at,
                planned_start_at,
                live_estimated_start_at
             FROM tbl_appointments
             WHERE is_active = 1
               AND status <> 'Cancelled'
               AND (${groupConditions.join(' OR ')})
             ORDER BY appointment_date ASC, fk_branch_id ASC, fk_slot_id ASC, current_token_number ASC, created_at ASC`,
            groupParams
        );

        const blankTimelineRows = [];
        for (const group of queueGroups.values()) {
            const slot = await getSlotQueueContext({
                slotId: group.fk_slot_id,
                branchId: group.fk_branch_id,
                appointmentDate: normalizeQueueDateKey(group.appointment_date),
            });
            const groupTimelineRows = queueTimelineRows.filter((row) => (
                normalizeQueueDateKey(row.appointment_date) === slot.appointmentDate
                && Number(row.fk_branch_id) === slot.branchId
                && Number(row.fk_slot_id) === slot.slotId
            ));

            blankTimelineRows.push(...await buildPlateBlankTimelineRows({
                execute: query,
                branchId: slot.branchId,
                slotId: slot.slotId,
                appointmentDate: slot.appointmentDate,
                slotStartTime: slot.slotStartTime,
                timelineRows: groupTimelineRows,
            }));

            const protectedWindowAppointmentIds = await getActiveProtectedWindowAppointmentIds(query, {
                branchId: slot.branchId,
                slotId: slot.slotId,
                appointmentDate: slot.appointmentDate,
            });

            if (protectedWindowAppointmentIds.length > 0) {
                protectedWindowAppointmentIdsByGroup.set(
                    [slot.appointmentDate, slot.branchId, slot.slotId].join(':'),
                    protectedWindowAppointmentIds
                );
            }
        }

        queueTimelineRows = [
            ...queueTimelineRows,
            ...blankTimelineRows,
        ];
    }

    const decoratedRows = sortAppointmentsByRuntimeQueue(rows, {
        sessions: queueSessions,
        timelineRows: queueTimelineRows,
        protectedWindowAppointmentIdsByGroup,
    });

    return res.status(200).json({
        success: true,
        message: 'Receptionist appointments fetched successfully',
        data: decoratedRows,
        meta: {
            filters: {
                branch_id: branchId,
                slot_id: slotId,
                appointment_date: appointmentDate,
                patient_search: patientSearch,
                booked_by_type: bookedByType,
                booked_for_type: bookedForType,
                reception_status: receptionStatus,
            },
            total: decoratedRows.length,
        },
    });
});

const saveReceptionistAppointmentVitals = asyncHandler(async (req, res) => {
    await ensureVitalsColumnsExist();
    const appointmentId = toPositiveInt(req.params.appointment_id);

    if (!appointmentId) {
        throw new AppError('Valid appointment_id is required', 400);
    }

    const vitals = parseAppointmentVitalsPayload(req.body);

    const updatedAppointment = await withTransaction(async (connection) => {
        const [appointmentRows] = await connection.execute(
            `SELECT appointment_id, fk_branch_id, status, is_active
             FROM tbl_appointments
             WHERE appointment_id = ?
             LIMIT 1
             FOR UPDATE`,
            [appointmentId]
        );

        if (appointmentRows.length === 0) {
            throw new AppError('Appointment not found', 404);
        }

        const appointment = appointmentRows[0];

        if (req.selectedBranchId && Number(appointment.fk_branch_id) !== Number(req.selectedBranchId)) {
            throw new AppError('You can update vitals only for the selected branch appointment', 403);
        }

        if (Number(appointment.is_active) !== 1 || appointment.status === 'Cancelled') {
            throw new AppError('Vitals cannot be updated for a cancelled or inactive appointment', 409);
        }

        let isVitalsColumnsEnsured = false;
        if (!isVitalsColumnsEnsured) {
            const extCols = [
                'occupation TEXT NULL',
                'history_present_illness TEXT NULL',
                'history_past_illness TEXT NULL',
                'family_history TEXT NULL',
                'allergies_history TEXT NULL',
                'gynecological_history TEXT NULL',
                'personal_social_history TEXT NULL',
                'general_examination TEXT NULL',
                'systematic_examination TEXT NULL',
                'differential_diagnosis TEXT NULL',
                'follow_up TEXT NULL',
                'disease VARCHAR(255) NULL',
                'mental_mind_status TEXT NULL',
            ];
            for (const colDef of extCols) {
                try {
                    await connection.execute(`ALTER TABLE tbl_appointment_vitals ADD COLUMN ${colDef}`);
                } catch (_err) {}
            }
            isVitalsColumnsEnsured = true;
        }

        if (vitals.has_any_value) {
            await connection.execute(
                `INSERT INTO tbl_appointment_vitals
                 (appointment_id, oxygen_saturation, blood_pressure, patient_height, patient_weight,
                  occupation, history_present_illness, history_past_illness, family_history, allergies_history,
                  gynecological_history, personal_social_history, general_examination, systematic_examination,
                  differential_diagnosis, follow_up, disease, mental_mind_status,
                  captured_by_role, captured_by_user_id, captured_at, updated_by_role, updated_by_user_id, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?, ?, NOW())
                 ON DUPLICATE KEY UPDATE
                    oxygen_saturation = COALESCE(VALUES(oxygen_saturation), oxygen_saturation),
                    blood_pressure = COALESCE(VALUES(blood_pressure), blood_pressure),
                    patient_height = COALESCE(VALUES(patient_height), patient_height),
                    patient_weight = COALESCE(VALUES(patient_weight), patient_weight),
                    occupation = COALESCE(VALUES(occupation), occupation),
                    history_present_illness = COALESCE(VALUES(history_present_illness), history_present_illness),
                    history_past_illness = COALESCE(VALUES(history_past_illness), history_past_illness),
                    family_history = COALESCE(VALUES(family_history), family_history),
                    allergies_history = COALESCE(VALUES(allergies_history), allergies_history),
                    gynecological_history = COALESCE(VALUES(gynecological_history), gynecological_history),
                    personal_social_history = COALESCE(VALUES(personal_social_history), personal_social_history),
                    general_examination = COALESCE(VALUES(general_examination), general_examination),
                    systematic_examination = COALESCE(VALUES(systematic_examination), systematic_examination),
                    differential_diagnosis = COALESCE(VALUES(differential_diagnosis), differential_diagnosis),
                    follow_up = COALESCE(VALUES(follow_up), follow_up),
                    disease = COALESCE(VALUES(disease), disease),
                    mental_mind_status = COALESCE(VALUES(mental_mind_status), mental_mind_status),
                    updated_by_role = VALUES(updated_by_role),
                    updated_by_user_id = VALUES(updated_by_user_id),
                    updated_at = NOW()`,
                [
                    appointmentId,
                    vitals.oxygen_saturation,
                    vitals.blood_pressure,
                    vitals.patient_height,
                    vitals.patient_weight,
                    vitals.occupation,
                    vitals.history_present_illness,
                    vitals.history_past_illness,
                    vitals.family_history,
                    vitals.allergies_history,
                    vitals.gynecological_history,
                    vitals.personal_social_history,
                    vitals.general_examination,
                    vitals.systematic_examination,
                    vitals.differential_diagnosis,
                    vitals.follow_up,
                    vitals.disease,
                    vitals.mental_mind_status,
                    req.user.role_code,
                    req.user.id,
                    req.user.role_code,
                    req.user.id,
                ]
            );

            try {
                await connection.execute(
                    `UPDATE tbl_consultations
                     SET occupation = COALESCE(?, occupation),
                         history_present_illness = COALESCE(?, history_present_illness),
                         history_past_illness = COALESCE(?, history_past_illness),
                         family_history = COALESCE(?, family_history),
                         allergies_history = COALESCE(?, allergies_history),
                         gynecological_history = COALESCE(?, gynecological_history),
                         personal_social_history = COALESCE(?, personal_social_history),
                         general_examination = COALESCE(?, general_examination),
                         systematic_examination = COALESCE(?, systematic_examination),
                         differential_diagnosis = COALESCE(?, differential_diagnosis),
                         follow_up = COALESCE(?, follow_up),
                         disease = COALESCE(?, disease),
                         mental_mind_status = COALESCE(?, mental_mind_status)
                     WHERE appointment_id = ?`,
                    [
                        vitals.occupation,
                        vitals.history_present_illness,
                        vitals.history_past_illness,
                        vitals.family_history,
                        vitals.allergies_history,
                        vitals.gynecological_history,
                        vitals.personal_social_history,
                        vitals.general_examination,
                        vitals.systematic_examination,
                        vitals.differential_diagnosis,
                        vitals.follow_up,
                        vitals.disease,
                        vitals.mental_mind_status,
                        appointmentId,
                    ]
                );
            } catch (_consultError) {}
        } else {
            await connection.execute(
                `DELETE FROM tbl_appointment_vitals
                 WHERE appointment_id = ?`,
                [appointmentId]
            );
        }

        return getAppointmentDetailsById(appointmentId);
    });

    return res.status(200).json({
        success: true,
        message: 'Appointment vitals saved successfully',
        data: updatedAppointment,
    });
});

const markAppointmentNotAvailable = asyncHandler(async (req, res) => {
    const appointmentId = toPositiveInt(req.params.appointment_id);
    const reason = req.body?.reason ? String(req.body.reason).trim() : 'NOT_AVAILABLE';

    if (!appointmentId) {
        throw new AppError('Valid appointment_id is required', 400);
    }

    const appointment = await withTransaction(async (connection) => {
        const [appointmentRows] = await connection.execute(
            `SELECT appointment_id, fk_branch_id, fk_slot_id, appointment_date, token_number, current_token_number, queue_status, status, is_active
             FROM tbl_appointments
             WHERE appointment_id = ?
             LIMIT 1
             FOR UPDATE`,
            [appointmentId]
        );

        if (appointmentRows.length === 0) {
            throw new AppError('Appointment not found', 404);
        }

        const current = appointmentRows[0];

        if (Number(current.is_active) !== 1) {
            throw new AppError('Only active appointments can be marked not available', 409);
        }

        if (current.status === 'Completed' || current.status === 'Cancelled') {
            throw new AppError('Completed or cancelled appointment cannot be marked not available', 409);
        }

        const [sameQueueRows] = await connection.execute(
            `SELECT appointment_id, token_number, current_token_number
             FROM tbl_appointments
             WHERE fk_branch_id = ?
               AND fk_slot_id = ?
               AND appointment_date = ?
               AND is_active = 1
               AND appointment_id != ?
               AND current_token_number > ?
             ORDER BY current_token_number ASC
             FOR UPDATE`,
            [
                current.fk_branch_id,
                current.fk_slot_id,
                current.appointment_date,
                appointmentId,
                current.current_token_number,
            ]
        );

        for (const row of sameQueueRows) {
            await connection.execute(
                `UPDATE tbl_appointments
                 SET token_number = token_number - 1,
                     current_token_number = current_token_number - 1,
                     updated_by = ?,
                     updated_ip = ?
                 WHERE appointment_id = ?`,
                [req.user.id, getClientIp(req), row.appointment_id]
            );
        }

        const [maxTokenRows] = await connection.execute(
            `SELECT MAX(token_number) AS max_token
             FROM tbl_appointments
             WHERE fk_branch_id = ?
               AND fk_slot_id = ?
               AND appointment_date = ?
               AND is_active = 1`,
            [current.fk_branch_id, current.fk_slot_id, current.appointment_date]
        );
        const maxToken = maxTokenRows[0]?.max_token ? Number(maxTokenRows[0].max_token) : Number(current.token_number);
        const newTokenNumber = maxToken + 1;

        await connection.execute(
            `UPDATE tbl_appointments
             SET status = 'Pending',
                 token_number = ?,
                 original_token_number = ?,
                 current_token_number = ?,
                 queue_status = ?,
                 actual_called_at = NULL,
                 checked_in_at = NULL,
                 arrival_sequence = NULL,
                 is_shifted = 1,
                 shift_reason = ?,
                 not_available_at = NOW(),
                 last_queue_event_at = NOW(),
                 updated_by = ?,
                 updated_ip = ?
             WHERE appointment_id = ?`,
            [newTokenNumber, newTokenNumber, newTokenNumber, QUEUE_STATUS.WAITING, reason, req.user.id, getClientIp(req), appointmentId]
        );

        await recalculateQueuePlan(connection, {
            branchId: Number(current.fk_branch_id),
            slotId: Number(current.fk_slot_id),
            appointmentDate: current.appointment_date,
            actorUserId: req.user.id,
            actorIp: getClientIp(req),
        });

        await connection.execute(
            `UPDATE tbl_live_queue_sessions
             SET current_appointment_id = CASE WHEN current_appointment_id = ? THEN NULL ELSE current_appointment_id END,
                 current_token_number = CASE WHEN current_appointment_id = ? THEN NULL ELSE current_token_number END,
                 updated_by = ?
             WHERE fk_branch_id = ?
               AND fk_slot_id = ?
               AND appointment_date = ?`,
            [
                appointmentId,
                appointmentId,
                req.user.id,
                current.fk_branch_id,
                current.fk_slot_id,
                current.appointment_date,
            ]
        );

        await logQueueEvent(connection, {
            appointmentId,
            branchId: Number(current.fk_branch_id),
            slotId: Number(current.fk_slot_id),
            appointmentDate: current.appointment_date,
            tokenNumber: newTokenNumber,
            eventType: 'TOKEN_SHIFTED',
            oldQueueStatus: current.queue_status,
            newQueueStatus: QUEUE_STATUS.WAITING,
            createdBy: req.user.id,
            meta: {
                reason,
                action: 'MOVE_TO_END',
            },
        });

        return getAppointmentDetailsById(appointmentId);
    });

    await emitLiveQueueEvent({
        branchId: Number(appointment.fk_branch_id),
        slotId: Number(appointment.fk_slot_id),
        appointmentDate: appointment.appointment_date,
        eventName: 'token-shifted',
        reason: 'TOKEN_SHIFTED',
        appointmentId,
    });

    return res.status(200).json({
        success: true,
        message: 'Appointment marked not available and moved to last token successfully',
        data: appointment,
    });
});

const rescheduleAppointmentByReceptionist = asyncHandler(async (req, res) => {
    const appointmentId = toPositiveInt(req.params.appointment_id);
    const {
        fk_branch_id,
        fk_treatment_id,
        fk_slot_id,
        appointment_date,
        symptoms = null,
        token_number = null,
        reason = null,
    } = req.body || {};

    if (!appointmentId) {
        throw new AppError('Valid appointment_id is required', 400);
    }

    const branchId = toPositiveInt(fk_branch_id);
    const treatmentId = toPositiveInt(fk_treatment_id);
    const slotId = toPositiveInt(fk_slot_id);

    if (!branchId || !treatmentId || !slotId || !appointment_date) {
        throw new AppError('fk_branch_id, fk_treatment_id, fk_slot_id and appointment_date are required', 400);
    }

    if (!isValidDateString(appointment_date)) {
        throw new AppError('appointment_date must be in YYYY-MM-DD format', 400);
    }

    let tokenNumber = null;
    if (token_number !== null && token_number !== undefined && token_number !== '') {
        tokenNumber = toPositiveInt(token_number);
        if (!tokenNumber || tokenNumber < 1) {
            throw new AppError('token_number must be a positive integer', 400);
        }
    }

    const createdIp = getClientIp(req);

    const rescheduleResult = await withTransaction(async (connection) => {
        const [oldRows] = await connection.execute(
            `SELECT appointment_id, fk_patient_id, fk_patient_family_member_id, booked_for_type, fk_branch_id, fk_slot_id, appointment_date, current_token_number, queue_status, status, is_active, consultation_bill_id, consultation_payment_status, consultation_payment_settlement_type
             FROM tbl_appointments
             WHERE appointment_id = ?
             LIMIT 1
             FOR UPDATE`,
            [appointmentId]
        );

        if (oldRows.length === 0) {
            throw new AppError('Appointment not found', 404);
        }

        const oldAppointment = oldRows[0];

        if (Number(oldAppointment.is_active) !== 1) {
            throw new AppError('Only active appointments can be rescheduled', 409);
        }

        if (oldAppointment.status === 'Completed' || oldAppointment.status === 'Cancelled') {
            throw new AppError('Completed or cancelled appointment cannot be rescheduled', 409);
        }

        if (
            oldAppointment.fk_branch_id === branchId &&
            oldAppointment.fk_slot_id === slotId &&
            oldAppointment.appointment_date === appointment_date
        ) {
            throw new AppError('Reschedule target cannot be the same as the existing appointment', 409);
        }

        const conflictCondition = buildBookingConflictCondition({
            bookedForType: oldAppointment.booked_for_type || BOOKED_FOR_TYPES.SELF,
            primaryPatientId: oldAppointment.fk_patient_id,
            familyMemberId: oldAppointment.fk_patient_family_member_id,
        });

        const [conflictingPatientAppointments] = await connection.execute(
            `SELECT appointment_id
             FROM tbl_appointments
             WHERE ${conflictCondition.sql}
               AND appointment_date = ?
               AND is_active = 1
               AND status IN ('Pending', 'Confirmed')
               AND COALESCE(reception_status, '') <> 'REJECTED_BY_RECEPTION'
               AND COALESCE(queue_status, '') <> 'CANCELLED'
               AND appointment_id != ?
             LIMIT 1
             FOR UPDATE`,
            [...conflictCondition.params, appointment_date, appointmentId]
        );

        if (conflictingPatientAppointments.length > 0) {
            throw new AppError('This patient already has an unresolved active appointment for the selected date', 409);
        }

        const [branchRows] = await connection.execute(
            'SELECT id FROM master_clinic_branches WHERE id = ? AND is_active = 1 LIMIT 1',
            [branchId]
        );
        const [treatmentRows] = await connection.execute(
            'SELECT id, treatment_code, treatment_name, consultation_fee FROM master_treatments WHERE id = ? AND is_active = 1 LIMIT 1',
            [treatmentId]
        );
        const [slotRows] = await connection.execute(
            'SELECT id, fk_branch_id, start_time, end_time, COALESCE(default_consult_minutes, 15) AS default_consult_minutes FROM master_slots WHERE id = ? AND is_active = 1 LIMIT 1',
            [slotId]
        );

        if (branchRows.length === 0) {
            throw new AppError('Selected branch not found or inactive', 404);
        }
        if (treatmentRows.length === 0) {
            throw new AppError('Selected treatment not found or inactive', 404);
        }
        if (slotRows.length === 0) {
            throw new AppError('Selected slot not found or inactive', 404);
        }
        if (Number(slotRows[0].fk_branch_id) !== branchId) {
            throw new AppError('Selected slot does not belong to the selected branch', 400);
        }

        const visitTypeCode = getVisitTypeCode({
            treatmentId,
            treatmentName: treatmentRows[0]?.treatment_name,
            treatmentCode: treatmentRows[0]?.treatment_code,
        });
        const consultationPaymentSettlementType = isFollowUpBookingVisitType(visitTypeCode)
            ? PAYMENT_SETTLEMENT_TYPES.FOLLOW_UP
            : PAYMENT_SETTLEMENT_TYPES.COLLECTED;

        const effectiveTiming = await resolveEffectiveSlotTiming({
            executor: connection,
            branchId,
            slotId,
            appointmentDate: appointment_date,
        });
        validateSlotBookingCutoff({
            appointmentDate: appointment_date,
            slotEndTime: effectiveTiming.effectiveEndTime,
        });

        const [queueRows] = await connection.execute(
            `SELECT appointment_id
             FROM tbl_appointments
             WHERE fk_branch_id = ?
               AND fk_slot_id = ?
               AND appointment_date = ?
               AND is_active = 1
               AND appointment_id != ?
               AND current_token_number > ?
             ORDER BY current_token_number ASC
             FOR UPDATE`,
            [
                oldAppointment.fk_branch_id,
                oldAppointment.fk_slot_id,
                oldAppointment.appointment_date,
                appointmentId,
                oldAppointment.current_token_number,
            ]
        );

        for (const row of queueRows) {
            await connection.execute(
                `UPDATE tbl_appointments
                 SET current_token_number = current_token_number - 1,
                     updated_by = ?,
                     updated_ip = ?
                 WHERE appointment_id = ?`,
                [req.user.id, createdIp, row.appointment_id]
            );
        }

        await connection.execute(
            `UPDATE tbl_appointments
             SET status = 'Cancelled',
                 is_active = 0,
                 queue_status = ?,
                 reschedule_reason = ?,
                 last_queue_event_at = NOW(),
                 updated_by = ?,
                 updated_ip = ?
             WHERE appointment_id = ?`,
            [QUEUE_STATUS.CANCELLED, reason ? String(reason).trim() : null, req.user.id, createdIp, appointmentId]
        );

        const [bookedAppointments] = await connection.execute(
            `SELECT token_number, current_token_number
             FROM tbl_appointments
             WHERE fk_branch_id = ?
               AND fk_slot_id = ?
               AND appointment_date = ?
               AND is_active = 1
               AND status <> 'Cancelled'
               AND COALESCE(reception_status, '') <> 'REJECTED_BY_RECEPTION'
               AND COALESCE(queue_status, '') <> 'CANCELLED'
             FOR UPDATE`,
            [branchId, slotId, appointment_date]
        );

        const bookedFixedTokenNumbers = new Set(
            bookedAppointments
                .map((appointment) => Number(appointment.token_number))
                .filter((value) => Number.isInteger(value) && value > 0)
        );
        const bookedCurrentTokenNumbers = new Set(
            bookedAppointments
                .map((appointment) => Number(appointment.current_token_number))
                .filter((value) => Number.isInteger(value) && value > 0)
        );

        const slotTokenPlate = supportsTokenPlateVisitType(visitTypeCode)
            ? await buildEffectiveSlotTokenPlate({
                executor: connection,
                branchId,
                slotId,
                appointmentDate: appointment_date,
                slotStartTime: slotRows[0].start_time,
            })
            : null;

        const assignedTokens = assignAppointmentTokenNumbers({
            requestedTokenNumber: tokenNumber,
            bookedFixedTokenNumbers,
            bookedCurrentTokenNumbers,
            visitTypeCode: supportsTokenPlateVisitType(visitTypeCode) ? visitTypeCode : null,
            slotTokenPlate,
        });
        const assignedPlateToken = getPlateTokenByNumber(slotTokenPlate, assignedTokens.tokenNumber);
        const appointmentAuid = await generateTodayAppointmentAuid(connection);
        const bookingSubjectKey = getBookingSubjectKey({
            bookedForType: oldAppointment.booked_for_type || BOOKED_FOR_TYPES.SELF,
            primaryPatientId: oldAppointment.fk_patient_id,
            familyMemberId: oldAppointment.fk_patient_family_member_id,
        });

        const [insertResult] = await connection.execute(
            `INSERT INTO tbl_appointments
             (auid, fk_patient_id, fk_patient_family_member_id, booked_for_type, booking_subject_key, fk_branch_id, fk_treatment_id, assigned_visit_type_code, assigned_slot_duration_minutes, fk_slot_id, token_number, original_token_number, current_token_number, appointment_date, symptoms, status, reception_status, booked_by_type, booked_by_user_id, queue_status, last_queue_event_at, rescheduled_from_appointment_id, reschedule_reason, is_active, created_by, updated_by, created_ip, updated_ip)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Pending', 'APPROVED_BY_RECEPTION', 'RECEPTIONIST', ?, ?, NOW(), ?, ?, 1, ?, ?, ?, ?)`,
            [
                appointmentAuid,
                oldAppointment.fk_patient_id,
                oldAppointment.fk_patient_family_member_id,
                oldAppointment.booked_for_type || BOOKED_FOR_TYPES.SELF,
                bookingSubjectKey,
                branchId,
                treatmentId,
                assignedPlateToken?.visit_type_code || null,
                assignedPlateToken?.duration_minutes || null,
                slotId,
                assignedTokens.tokenNumber,
                assignedTokens.originalTokenNumber,
                assignedTokens.currentTokenNumber,
                appointment_date,
                symptoms ? String(symptoms).trim() : null,
                req.user.id,
                QUEUE_STATUS.BOOKED,
                appointmentId,
                reason ? String(reason).trim() : null,
                req.user.id,
                req.user.id,
                createdIp,
                createdIp,
            ]
        );

        if (oldAppointment.consultation_bill_id) {
            await transferConsultationBillToAppointment({
                connection,
                oldAppointmentId: appointmentId,
                newAppointmentId: insertResult.insertId,
                billId: oldAppointment.consultation_bill_id,
                paymentStatus: oldAppointment.consultation_payment_status,
                paymentSettlementType: oldAppointment.consultation_payment_settlement_type || PAYMENT_SETTLEMENT_TYPES.COLLECTED,
                actorUserId: req.user.id,
            });
        } else {
            await createConsultationBillForAppointment({
                connection,
                appointmentId: insertResult.insertId,
                patientId: oldAppointment.fk_patient_id,
                branchId,
                treatmentId,
                paymentSettlementType: consultationPaymentSettlementType,
                actorUserId: req.user.id,
            });
        }

        await recalculateQueuePlan(connection, {
            branchId: Number(oldAppointment.fk_branch_id),
            slotId: Number(oldAppointment.fk_slot_id),
            appointmentDate: oldAppointment.appointment_date,
            actorUserId: req.user.id,
            actorIp: createdIp,
        });

        await connection.execute(
            `UPDATE tbl_live_queue_sessions
             SET current_appointment_id = CASE WHEN current_appointment_id = ? THEN NULL ELSE current_appointment_id END,
                 current_token_number = CASE WHEN current_appointment_id = ? THEN NULL ELSE current_token_number END,
                 updated_by = ?
             WHERE fk_branch_id = ?
               AND fk_slot_id = ?
               AND appointment_date = ?`,
            [
                appointmentId,
                appointmentId,
                req.user.id,
                oldAppointment.fk_branch_id,
                oldAppointment.fk_slot_id,
                oldAppointment.appointment_date,
            ]
        );

        await recalculateQueuePlan(connection, {
            branchId,
            slotId,
            appointmentDate: appointment_date,
            actorUserId: req.user.id,
            actorIp: createdIp,
        });

        await logQueueEvent(connection, {
            appointmentId,
            branchId: Number(oldAppointment.fk_branch_id),
            slotId: Number(oldAppointment.fk_slot_id),
            appointmentDate: oldAppointment.appointment_date,
            tokenNumber: Number(oldAppointment.current_token_number),
            eventType: 'APPOINTMENT_RESCHEDULED_OLD_CANCELLED',
            oldQueueStatus: oldAppointment.queue_status,
            newQueueStatus: QUEUE_STATUS.CANCELLED,
            createdBy: req.user.id,
            meta: {
                reason: reason ? String(reason).trim() : null,
            },
        });

        await logQueueEvent(connection, {
            appointmentId: insertResult.insertId,
            branchId,
            slotId,
            appointmentDate: appointment_date,
            tokenNumber: assignedTokens.currentTokenNumber,
            eventType: 'APPOINTMENT_RESCHEDULED_NEW_CREATED',
            newQueueStatus: QUEUE_STATUS.BOOKED,
            createdBy: req.user.id,
            meta: {
                rescheduled_from_appointment_id: appointmentId,
                reason: reason ? String(reason).trim() : null,
            },
        });

        return {
            newAppointmentId: insertResult.insertId,
            oldQueueContext: {
                branchId: Number(oldAppointment.fk_branch_id),
                slotId: Number(oldAppointment.fk_slot_id),
                appointmentDate: oldAppointment.appointment_date,
            },
            newQueueContext: {
                branchId,
                slotId,
                appointmentDate: appointment_date,
            },
        };
    });

    const appointment = await getAppointmentDetailsById(rescheduleResult.newAppointmentId);

    await emitLiveQueueEvent({
        branchId: rescheduleResult.oldQueueContext.branchId,
        slotId: rescheduleResult.oldQueueContext.slotId,
        appointmentDate: rescheduleResult.oldQueueContext.appointmentDate,
        eventName: 'queue-updated',
        reason: 'APPOINTMENT_RESCHEDULED_OLD_CANCELLED',
        appointmentId,
    });

    await emitLiveQueueEvent({
        branchId: rescheduleResult.newQueueContext.branchId,
        slotId: rescheduleResult.newQueueContext.slotId,
        appointmentDate: rescheduleResult.newQueueContext.appointmentDate,
        eventName: 'queue-updated',
        reason: 'APPOINTMENT_RESCHEDULED_NEW_CREATED',
        appointmentId: rescheduleResult.newAppointmentId,
    });

    return res.status(201).json({
        success: true,
        message: 'Appointment rescheduled successfully',
        data: appointment,
    });
});

const listReceptionistPrescriptions = asyncHandler(async (req, res) => {
    const branchId = req.query.branch_id !== undefined ? toPositiveInt(req.query.branch_id) : null;
    const requestedWorkflowStatus = req.query.workflow_status
        ? String(req.query.workflow_status).trim().toUpperCase()
        : null;
    const allowedWorkflowStatuses = new Set(['READY_FOR_MEDICAL', 'PROCESSED_BY_MEDICAL']);

    if (req.query.branch_id !== undefined && !branchId) {
        throw new AppError('branch_id must be a positive integer', 400);
    }

    if (requestedWorkflowStatus && !allowedWorkflowStatuses.has(requestedWorkflowStatus)) {
        throw new AppError('workflow_status must be READY_FOR_MEDICAL or PROCESSED_BY_MEDICAL', 400);
    }

    const params = requestedWorkflowStatus ? [requestedWorkflowStatus] : ['READY_FOR_MEDICAL', 'PROCESSED_BY_MEDICAL'];
    const branchCondition = branchId ? ' AND a.fk_branch_id = ?' : '';

    if (branchId) {
        params.push(branchId);
    }

    const rows = await query(
        `SELECT
            c.id AS consultation_id,
            c.appointment_id,
            c.workflow_status,
            c.doctor_finalized_at,
            c.sent_to_medical_at,
            c.medical_processed_at,
            c.created_at,
            a.current_token_number AS token_number,
            a.original_token_number,
            a.current_token_number,
            COALESCE(fm.full_name, p.full_name) AS patient_full_name,
            p.mobile_no AS patient_mobile_no,
            fm.relationship AS family_member_relationship,
            a.booked_for_type,
            a.fk_patient_family_member_id,
            d.full_name AS doctor_name,
            a.appointment_date,
            b.branch_name,
            t.treatment_name
         FROM tbl_consultations c
         JOIN tbl_appointments a ON a.appointment_id = c.appointment_id
         JOIN master_users p ON p.id = a.fk_patient_id
         LEFT JOIN tbl_patient_family_members fm
           ON fm.id = a.fk_patient_family_member_id
         JOIN master_users d ON d.id = c.doctor_id
         JOIN master_clinic_branches b ON b.id = a.fk_branch_id
         JOIN master_treatments t ON t.id = a.fk_treatment_id
         WHERE c.workflow_status IN (${requestedWorkflowStatus ? '?' : '?, ?'})
           ${branchCondition}
         ORDER BY c.created_at DESC`,
        params
    );

    const summary = rows.reduce(
        (acc, row) => {
            if (row.workflow_status === 'READY_FOR_MEDICAL') {
                acc.ready_for_medical += 1;
            }

            if (row.workflow_status === 'PROCESSED_BY_MEDICAL') {
                acc.processed_by_medical += 1;
            }

            return acc;
        },
        {
            ready_for_medical: 0,
            processed_by_medical: 0,
        }
    );

    return res.status(200).json({
        success: true,
        message: 'Receptionist prescriptions fetched successfully',
        data: rows.map((row) => decorateTokenFields(row)),
        meta: {
            filters: {
                workflow_status: requestedWorkflowStatus || 'READY_FOR_MEDICAL,PROCESSED_BY_MEDICAL',
                branch_id: branchId,
            },
            total: rows.length,
            summary,
            read_only: true,
        },
    });
});

const approveReceptionistAppointment = asyncHandler(async (req, res) => {
    const appointmentId = toPositiveInt(req.params.appointment_id);

    if (!appointmentId) {
        throw new AppError('Valid appointment_id is required', 400);
    }

    const transactionResult = await withTransaction(async (connection) => {
        const [rows] = await connection.execute(
            `SELECT appointment_id, status, is_active, reception_status, fk_patient_id, fk_branch_id, fk_treatment_id, fk_slot_id, appointment_date, current_token_number, queue_status, consultation_bill_id, consultation_payment_status, consultation_payment_settlement_type
             FROM tbl_appointments
             WHERE appointment_id = ?
             LIMIT 1
             FOR UPDATE`,
            [appointmentId]
        );

        if (rows.length === 0) {
            throw new AppError('Appointment not found', 404);
        }

        const appointment = rows[0];

        if (Number(appointment.is_active) !== 1 || appointment.status === 'Cancelled') {
            throw new AppError('Only active non-cancelled appointments can be approved by receptionist', 409);
        }

        if (appointment.reception_status === 'APPROVED_BY_RECEPTION' && appointment.consultation_payment_status === 'PAID') {
            throw new AppError('Appointment is already approved by receptionist', 409);
        }

        let billId = appointment.consultation_bill_id;
        const isFollowUpSettlement = appointment.consultation_payment_settlement_type === PAYMENT_SETTLEMENT_TYPES.FOLLOW_UP;
        const isFollowUpAutoPaid = isFollowUpSettlement && appointment.consultation_payment_status === 'PAID';

        if (!billId) {
            const billResult = await createConsultationBillForAppointment({
                connection,
                appointmentId,
                patientId: appointment.fk_patient_id,
                branchId: appointment.fk_branch_id,
                treatmentId: appointment.fk_treatment_id,
                paymentSettlementType: isFollowUpSettlement
                    ? PAYMENT_SETTLEMENT_TYPES.FOLLOW_UP
                    : PAYMENT_SETTLEMENT_TYPES.COLLECTED,
                actorUserId: req.user.id,
            });
            billId = billResult.billId;
        }

        if (!isFollowUpAutoPaid) {
            const payment = parsePaymentCollectionPayload(req.body);

            await collectConsultationBillPayment({
                connection,
                billId,
                appointmentId,
                amount: payment.amount,
                paymentMode: payment.paymentMode,
                transactionReference: payment.transactionReference,
                remark: payment.remark,
                collectedByUserId: req.user.id,
                collectedByRole: req.user.role_code,
            });
        }

        await connection.execute(
            `UPDATE tbl_appointments
             SET reception_status = 'APPROVED_BY_RECEPTION',
                 queue_status = CASE
                     WHEN queue_status IN ('CANCELLED', 'NO_SHOW', 'SKIPPED') THEN ?
                     ELSE queue_status
                 END,
                 reception_approved_at = NOW(),
                 reception_approved_by = ?,
                 reception_rejected_at = NULL,
                 reception_rejected_by = NULL,
                 reception_rejection_reason = NULL,
                 last_queue_event_at = NOW(),
                 updated_by = ?
             WHERE appointment_id = ?`,
            [QUEUE_STATUS.BOOKED, req.user.id, req.user.id, appointmentId]
        );

        if (appointment.reception_status === 'REJECTED_BY_RECEPTION' || appointment.queue_status === QUEUE_STATUS.CANCELLED) {
            const [bookedAppointments] = await connection.execute(
                `SELECT current_token_number
                 FROM tbl_appointments
                 WHERE fk_branch_id = ?
                   AND fk_slot_id = ?
                   AND appointment_date = ?
                   AND is_active = 1
                   AND appointment_id != ?
                   AND queue_status IN ('BOOKED', 'CHECKED_IN', 'WAITING', 'IN_PROGRESS')
                 FOR UPDATE`,
                [appointment.fk_branch_id, appointment.fk_slot_id, appointment.appointment_date, appointmentId]
            );

            const bookedTokenNumbers = new Set(
                bookedAppointments
                    .map((item) => Number(item.current_token_number))
                    .filter((value) => Number.isInteger(value) && value > 0)
            );

            const reassignedTokenNumber = getNextAvailableTokenNumber(
                bookedTokenNumbers,
                getBranchMaxTokenNumber(appointment.fk_branch_id)
            );

            await connection.execute(
                `UPDATE tbl_appointments
                 SET current_token_number = ?,
                     queue_status = ?,
                     actual_called_at = NULL,
                     checked_in_at = NULL,
                     arrival_sequence = NULL,
                     updated_by = ?
                 WHERE appointment_id = ?`,
                [reassignedTokenNumber, QUEUE_STATUS.BOOKED, req.user.id, appointmentId]
            );

            await recalculateQueuePlan(connection, {
                branchId: Number(appointment.fk_branch_id),
                slotId: Number(appointment.fk_slot_id),
                appointmentDate: appointment.appointment_date,
                actorUserId: req.user.id,
                actorIp: getClientIp(req),
            });

            await logQueueEvent(connection, {
                appointmentId,
                branchId: Number(appointment.fk_branch_id),
                slotId: Number(appointment.fk_slot_id),
                appointmentDate: appointment.appointment_date,
                tokenNumber: reassignedTokenNumber,
                eventType: 'RECEPTION_APPROVED_TO_QUEUE',
                oldQueueStatus: appointment.queue_status,
                newQueueStatus: QUEUE_STATUS.BOOKED,
                createdBy: req.user.id,
            });
        }

        return {
            billId,
            appointmentWasAlreadyApproved: appointment.reception_status === 'APPROVED_BY_RECEPTION',
            approvedWithoutPaymentCollection: isFollowUpAutoPaid,
        };
    });

    const appointment = await getAppointmentDetailsById(appointmentId);
    const bill = transactionResult.billId ? await getBillDetailById(transactionResult.billId) : null;

    await emitLiveQueueEvent({
        branchId: Number(appointment.fk_branch_id),
        slotId: Number(appointment.fk_slot_id),
        appointmentDate: appointment.appointment_date,
        eventName: 'queue-updated',
        reason: 'RECEPTION_APPROVED',
        appointmentId,
    });

    emitToRole('DOC', 'doctor.appointments.updated', {
        reason: transactionResult.approvedWithoutPaymentCollection
            ? 'RECEPTION_APPROVED_FOLLOW_UP'
            : transactionResult.appointmentWasAlreadyApproved
            ? 'CONSULTATION_PAYMENT_COLLECTED'
            : 'RECEPTION_APPROVED_AND_PAYMENT_COLLECTED',
        source: 'RECEPTION_APPROVAL',
        appointment,
    });

    return res.status(200).json({
        success: true,
        message: transactionResult.appointmentWasAlreadyApproved
            ? 'Consultation payment collected successfully for approved appointment'
            : transactionResult.approvedWithoutPaymentCollection
                ? 'Follow-up appointment approved successfully'
            : 'Appointment approved and consultation payment collected successfully',
        data: {
            appointment,
            bill,
        },
    });
});

const rejectAndCleanupAppointmentsInternal = async (connection, appointmentIds, reason, actorUserId, actorIp) => {
    if (!appointmentIds || appointmentIds.length === 0) return;

    // 1. Fetch details of targeted appointments to know where they belong and lock them
    const [appointments] = await connection.query(
        `SELECT appointment_id, fk_branch_id, fk_slot_id, appointment_date, current_token_number, queue_status, status, is_active
         FROM tbl_appointments
         WHERE appointment_id IN (?)
         FOR UPDATE`,
         [appointmentIds]
    );

    if (appointments.length === 0) {
        throw new AppError('No appointments found to reject', 404);
    }

    for (const appt of appointments) {
        if (appt.status === 'Completed') {
            throw new AppError('Cannot reject completed appointment', 409);
        }
    }

    // Group appointments by branch, slot, date
    const appointmentsByGroup = {};
    for (const appt of appointments) {
        const key = `${appt.fk_branch_id}_${appt.fk_slot_id}_${appt.appointment_date}`;
        if (!appointmentsByGroup[key]) {
            appointmentsByGroup[key] = [];
        }
        appointmentsByGroup[key].push(appt);
    }

    // 2. Perform token shifts for each group
    for (const key of Object.keys(appointmentsByGroup)) {
        const groupAppts = appointmentsByGroup[key];
        // Sort from highest current_token_number to lowest
        groupAppts.sort((a, b) => b.current_token_number - a.current_token_number);

        for (const appt of groupAppts) {
            if (ACTIVE_QUEUE_STATUSES.includes(appt.queue_status)) {
                await connection.execute(
                    `UPDATE tbl_appointments
                     SET current_token_number = current_token_number - 1,
                         updated_by = ?,
                         updated_ip = ?
                     WHERE fk_branch_id = ?
                       AND fk_slot_id = ?
                       AND appointment_date = ?
                       AND is_active = 1
                       AND current_token_number > ?
                       AND queue_status IN (${ACTIVE_QUEUE_STATUSES.map(() => '?').join(', ')})`,
                    [
                        actorUserId,
                        actorIp,
                        appt.fk_branch_id,
                        appt.fk_slot_id,
                        appt.appointment_date,
                        appt.current_token_number,
                        ...ACTIVE_QUEUE_STATUSES
                    ]
                );
            }
        }
    }

    // 3. Find related entity IDs (consultations and bills)
    const [consultationRows] = await connection.query(
        `SELECT id FROM tbl_consultations WHERE appointment_id IN (?)`,
        [appointmentIds]
    );
    const consultationIds = consultationRows.map(r => r.id);

    const [billRows] = await connection.query(
        `SELECT id FROM tbl_bills WHERE appointment_id IN (?)`,
        [appointmentIds]
    );
    const billIds = billRows.map(r => r.id);

    // 4. Delete consultation sub-entities first
    if (consultationIds.length > 0) {
        const [medicationRows] = await connection.query(
            `SELECT id FROM tbl_consultation_medications WHERE consultation_id IN (?)`,
            [consultationIds]
        );
        const medicationIds = medicationRows.map(r => r.id);

        if (medicationIds.length > 0) {
            await connection.query(
                `DELETE FROM tbl_medication_dosages WHERE consultation_medication_id IN (?)`,
                [medicationIds]
            );
            await connection.query(
                `DELETE FROM tbl_medical_prescription_pricing_items WHERE consultation_medication_id IN (?)`,
                [medicationIds]
            );
        }

        const [pricingRows] = await connection.query(
            `SELECT id FROM tbl_medical_prescription_pricing WHERE consultation_id IN (?)`,
            [consultationIds]
        );
        const pricingIds = pricingRows.map(r => r.id);
        if (pricingIds.length > 0) {
            await connection.query(
                `DELETE FROM tbl_medical_prescription_pricing_items WHERE pricing_id IN (?)`,
                [pricingIds]
            );
            await connection.query(
                `DELETE FROM tbl_medical_prescription_pricing WHERE id IN (?)`,
                [pricingIds]
            );
        }

        await connection.query(
            `DELETE FROM tbl_consultation_medications WHERE consultation_id IN (?)`,
            [consultationIds]
        );

        await connection.query(
            `DELETE FROM tbl_consultation_tests WHERE consultation_id IN (?)`,
            [consultationIds]
        );
    }

    // 5. Delete bill items and payments
    if (billIds.length > 0) {
        await connection.query(
            `DELETE FROM tbl_bill_items WHERE bill_id IN (?)`,
            [billIds]
        );
        await connection.query(
            `DELETE FROM tbl_bill_payments WHERE bill_id IN (?)`,
            [billIds]
        );
    }

    // 6. Delete consultations and bills
    if (consultationIds.length > 0) {
        await connection.query(
            `DELETE FROM tbl_consultations WHERE id IN (?)`,
            [consultationIds]
        );
    }

    if (billIds.length > 0) {
        await connection.query(
            `DELETE FROM tbl_bills WHERE id IN (?)`,
            [billIds]
        );
    }

    // 7. Nullify queue session and self-references
    await connection.query(
        `UPDATE tbl_live_queue_sessions 
         SET current_appointment_id = NULL, current_token_number = NULL, updated_by = ?
         WHERE current_appointment_id IN (?)`,
        [actorUserId, appointmentIds]
    );

    await connection.query(
        `UPDATE tbl_appointments 
         SET rescheduled_from_appointment_id = NULL, updated_by = ?
         WHERE rescheduled_from_appointment_id IN (?)`,
        [actorUserId, appointmentIds]
    );

    await connection.query(
        `UPDATE tbl_appointments 
         SET parent_appointment_id = NULL, updated_by = ?
         WHERE parent_appointment_id IN (?)`,
        [actorUserId, appointmentIds]
    );

    // 8. Delete vitals and followups (retain tbl_appointment_queue_events for audit trail)
    await connection.query(
        `DELETE FROM tbl_appointment_vitals WHERE appointment_id IN (?)`,
        [appointmentIds]
    );

    await connection.query(
        `DELETE FROM tbl_bill_payments WHERE appointment_id IN (?)`,
        [appointmentIds]
    );

    await connection.query(
        `DELETE FROM tbl_pending_followups WHERE parent_appointment_id IN (?)`,
        [appointmentIds]
    );

    // 9. Update the appointments to rejected and is_active = 0
    await connection.query(
        `UPDATE tbl_appointments
         SET reception_status = 'REJECTED_BY_RECEPTION',
             queue_status = ?,
             status = 'Cancelled',
             is_active = 0,
             reception_rejected_at = NOW(),
             reception_rejected_by = ?,
             reception_rejection_reason = ?,
             reception_approved_at = NULL,
             reception_approved_by = NULL,
             consultation_bill_id = NULL,
             consultation_payment_status = 'UNPAID',
             consultation_payment_settlement_type = ?,
             last_queue_event_at = NOW(),
             updated_by = ?,
             updated_ip = ?
         WHERE appointment_id IN (?)`,
        [
            QUEUE_STATUS.CANCELLED,
            actorUserId,
            reason,
            PAYMENT_SETTLEMENT_TYPES.COLLECTED,
            actorUserId,
            actorIp,
            appointmentIds
        ]
    );

    // Log a new queue event for each rejected appointment to show it was rejected/cancelled
    for (const appt of appointments) {
        await logQueueEvent(connection, {
            appointmentId: appt.appointment_id,
            branchId: Number(appt.fk_branch_id),
            slotId: Number(appt.fk_slot_id),
            appointmentDate: appt.appointment_date,
            tokenNumber: appt.current_token_number || appt.token_number,
            eventType: 'RECEPTION_REJECTED',
            oldQueueStatus: appt.queue_status,
            newQueueStatus: QUEUE_STATUS.CANCELLED,
            createdBy: actorUserId,
            meta: {
                reason,
                action: 'REJECT_AND_CLEANUP',
            },
        });
    }

    // 10. Recalculate queue plans for each group
    for (const key of Object.keys(appointmentsByGroup)) {
        const groupAppts = appointmentsByGroup[key];
        const first = groupAppts[0];
        
        await recalculateQueuePlan(connection, {
            branchId: Number(first.fk_branch_id),
            slotId: Number(first.fk_slot_id),
            appointmentDate: first.appointment_date,
            actorUserId,
            actorIp,
        });
    }
};

const rejectReceptionistAppointment = asyncHandler(async (req, res) => {
    const appointmentId = toPositiveInt(req.params.appointment_id);
    const reason = req.body?.reason ? String(req.body.reason).trim() : 'Rejected by receptionist';

    if (!appointmentId) {
        throw new AppError('Valid appointment_id is required', 400);
    }

    await withTransaction(async (connection) => {
        await rejectAndCleanupAppointmentsInternal(connection, [appointmentId], reason, req.user.id, getClientIp(req));
    });

    const appointment = await getAppointmentDetailsById(appointmentId);

    await emitLiveQueueEvent({
        branchId: Number(appointment.fk_branch_id),
        slotId: Number(appointment.fk_slot_id),
        appointmentDate: appointment.appointment_date,
        eventName: 'queue-updated',
        reason: 'RECEPTION_REJECTED',
        appointmentId,
    });

    return res.status(200).json({
        success: true,
        message: 'Appointment rejected and cleaned up successfully',
        data: appointment,
    });
});

const bulkRejectReceptionistAppointments = asyncHandler(async (req, res) => {
    const { appointment_ids, reason } = req.body;
    const rejectReason = reason ? String(reason).trim() : 'Rejected in bulk by receptionist';

    if (!Array.isArray(appointment_ids) || appointment_ids.length === 0) {
        throw new AppError('An array of appointment_ids is required', 400);
    }

    const appointmentIds = appointment_ids.map(toPositiveInt).filter(Boolean);
    if (appointmentIds.length === 0) {
        throw new AppError('No valid appointment_ids provided', 400);
    }

    const selectedBranchId = Number(req.selectedBranchId);
    if (!selectedBranchId) {
        throw new AppError('Branch scope selection is required', 400);
    }

    let affectedGroups = [];

    await withTransaction(async (connection) => {
        // Security check: Verify all appointments belong to current selected branch
        const [rows] = await connection.query(
            `SELECT appointment_id, fk_branch_id, fk_slot_id, appointment_date
             FROM tbl_appointments
             WHERE appointment_id IN (?)`,
            [appointmentIds]
        );

        const isAllInBranch = rows.every(r => Number(r.fk_branch_id) === selectedBranchId);
        if (!isAllInBranch) {
            throw new AppError('You can only reject appointments belonging to your currently selected branch', 403);
        }

        affectedGroups = rows.reduce((acc, row) => {
            const exists = acc.some(g => g.branchId === row.fk_branch_id && g.slotId === row.fk_slot_id && g.appointmentDate === row.appointment_date);
            if (!exists) {
                acc.push({
                    branchId: Number(row.fk_branch_id),
                    slotId: Number(row.fk_slot_id),
                    appointmentDate: row.appointment_date
                });
            }
            return acc;
        }, []);

        await rejectAndCleanupAppointmentsInternal(connection, appointmentIds, rejectReason, req.user.id, getClientIp(req));
    });

    // Emit live queue events for all affected groups
    for (const group of affectedGroups) {
        await emitLiveQueueEvent({
            branchId: group.branchId,
            slotId: group.slotId,
            appointmentDate: group.appointmentDate,
            eventName: 'queue-updated',
            reason: 'RECEPTION_REJECTED',
        });
    }

    return res.status(200).json({
        success: true,
        message: 'Selected appointments rejected and cleaned up successfully',
    });
});

const getReceptionistPrescriptionDetail = asyncHandler(async (req, res) => {
    const consultationId = toPositiveInt(req.params.consultation_id);
    if (!consultationId) {
        throw new AppError('Valid consultation_id is required', 400);
    }

    const detail = await getPrescriptionDetailByConsultationId(consultationId);
    if (!detail) {
        throw new AppError('Prescription not found', 404);
    }

    return res.status(200).json({
        success: true,
        message: 'Receptionist prescription detail fetched successfully',
        data: detail,
    });
});

const getBranchTokenLayout = asyncHandler(async (req, res) => {
    const branchId = toPositiveInt(req.selectedBranchId || req.query.branch_id);
    if (!branchId) {
        throw new AppError('branch_id is required', 400);
    }

    const branchRows = await query(
        `SELECT id, branch_name FROM master_clinic_branches WHERE id = ? AND is_active = 1 LIMIT 1`,
        [branchId]
    );
    if (branchRows.length === 0) {
        throw new AppError('Branch not found or inactive', 444);
    }

    const rows = await query(
        `SELECT token_number, visit_type_code, duration_minutes 
         FROM tbl_branch_token_layouts 
         WHERE fk_branch_id = ? 
         ORDER BY token_number ASC`,
        [branchId]
    );

    let layout = [];
    const { isValidTokenPlateLayout } = require('../../utils/appointmentTokens');
    const savedLayout = rows.map((row) => row.visit_type_code);

    if (isValidTokenPlateLayout(savedLayout, branchId)) {
        layout = rows.map((r) => ({
            token_number: Number(r.token_number),
            visit_type_code: r.visit_type_code,
            duration_minutes: Number(r.duration_minutes) > 0 ? Number(r.duration_minutes) : null,
        }));
    } else {
        const defaultPlate = buildSlotTokenPlate({
            branchId,
            slotId: 1,
            appointmentDate: new Date().toISOString().split('T')[0],
            slotStartTime: '10:00',
            bookedTokenNumbers: new Set(),
            delayMinutes: 0,
        });
        layout = defaultPlate.map((t) => ({
            token_number: Number(t.token_number),
            visit_type_code: t.visit_type_code,
            duration_minutes: Number(t.duration_minutes) > 0 ? Number(t.duration_minutes) : null,
        }));
    }

    return res.status(200).json({
        success: true,
        message: 'Branch token layout fetched successfully',
        data: {
            branch_id: branchId,
            branch_name: branchRows[0].branch_name,
            token_count: getBranchMaxTokenNumber(branchId),
            token_rules: getBranchTokenPlateRules(branchId),
            layout,
        },
    });
});

const updateBranchTokenLayout = asyncHandler(async (req, res) => {
    const branchId = toPositiveInt(req.selectedBranchId || req.body.branch_id);
    const { layout } = req.body;

    if (!branchId) {
        throw new AppError('branch_id is required', 400);
    }

    const expectedTokenCount = getBranchMaxTokenNumber(branchId);
    const tokenRules = getBranchTokenPlateRules(branchId);

    if (!Array.isArray(layout) || layout.length !== expectedTokenCount) {
        throw new AppError(`Layout must be an array of exactly ${expectedTokenCount} tokens`, 400);
    }

    const branchRows = await query(
        `SELECT id FROM master_clinic_branches WHERE id = ? AND is_active = 1 LIMIT 1`,
        [branchId]
    );
    if (branchRows.length === 0) {
        throw new AppError('Branch not found or inactive', 444);
    }

    const parsedLayout = layout.map((item, index) => {
        const tokenNumber = index + 1;
        let visitTypeCode = '';
        if (typeof item === 'string') {
            visitTypeCode = item.trim();
        } else if (item && typeof item === 'object') {
            visitTypeCode = String(item.visit_type_code || '').trim();
        }

        if (!visitTypeCode) {
            throw new AppError(`Invalid visit type code at token number ${tokenNumber}`, 400);
        }
        return {
            token_number: tokenNumber,
            visit_type_code: visitTypeCode,
            duration_minutes: Number(item?.duration_minutes) > 0 ? Number(item.duration_minutes) : null,
        };
    });

    const counts = Object.keys(tokenRules).reduce((accumulator, visitTypeCode) => {
        accumulator[visitTypeCode] = 0;
        return accumulator;
    }, {});

    parsedLayout.forEach((item) => {
        if (counts[item.visit_type_code] === undefined) {
            throw new AppError(`Unsupported visit type code: ${item.visit_type_code}`, 400);
        }
        counts[item.visit_type_code] += 1;
    });

    Object.entries(tokenRules).forEach(([visitTypeCode, rule]) => {
        if (counts[visitTypeCode] !== rule.count) {
            throw new AppError(
                `${rule.label} count must be exactly ${rule.count}, received ${counts[visitTypeCode]}`,
                400
            );
        }
    });

    await withTransaction(async (connection) => {
        await connection.execute(
            `DELETE FROM tbl_branch_token_layouts WHERE fk_branch_id = ?`,
            [branchId]
        );

        for (const item of parsedLayout) {
            await connection.execute(
                `INSERT INTO tbl_branch_token_layouts (fk_branch_id, token_number, visit_type_code, duration_minutes)
                 VALUES (?, ?, ?, ?)`,
                [branchId, item.token_number, item.visit_type_code, item.duration_minutes]
            );
        }
    });

    const { branchLayoutsCache } = require('../../utils/appointmentTokens');
    branchLayoutsCache[branchId] = parsedLayout.map((item) => ({
        visit_type_code: item.visit_type_code,
        duration_minutes: item.duration_minutes,
    }));

    return res.status(200).json({
        success: true,
        message: 'Branch token layout saved and applied successfully',
    });
});

const getBranchExtensionTokenLayout = asyncHandler(async (req, res) => {
    const branchId = toPositiveInt(req.selectedBranchId || req.query.branch_id);
    if (!branchId) {
        throw new AppError('branch_id is required', 400);
    }

    const [branchRows, mixRows, savedRows] = await Promise.all([
        query(
            `SELECT id, branch_name FROM master_clinic_branches
             WHERE id = ? AND is_active = 1 LIMIT 1`,
            [branchId]
        ),
        query(
            `SELECT t.treatment_code, m.token_count
             FROM master_token_extension_mix m
             JOIN master_treatments t ON t.id = m.fk_treatment_id
             WHERE m.is_active = 1 AND t.is_active = 1
             ORDER BY m.display_order ASC, m.id ASC`
        ),
        query(
            `SELECT sequence_number, treatment_code
             FROM tbl_branch_extension_token_layouts
             WHERE fk_branch_id = ?
             ORDER BY sequence_number ASC`,
            [branchId]
        ),
    ]);
    if (branchRows.length === 0) {
        throw new AppError('Branch not found or inactive', 404);
    }

    const defaultLayout = [];
    mixRows.forEach((row) => {
        for (let index = 0; index < Number(row.token_count); index += 1) {
            defaultLayout.push(row.treatment_code);
        }
    });
    const expectedCounts = Object.fromEntries(
        mixRows.map((row) => [row.treatment_code, Number(row.token_count)])
    );
    const savedLayout = savedRows.map((row) => row.treatment_code);
    const savedCounts = savedLayout.reduce((counts, code) => {
        counts[code] = (counts[code] || 0) + 1;
        return counts;
    }, {});
    const isSavedLayoutValid = savedLayout.length === defaultLayout.length
        && Object.entries(expectedCounts).every(([code, count]) => savedCounts[code] === count);
    const layout = isSavedLayoutValid ? savedLayout : defaultLayout;

    return res.status(200).json({
        success: true,
        message: 'Extra-hour token alignment fetched successfully',
        data: {
            branch_id: branchId,
            branch_name: branchRows[0].branch_name,
            layout: layout.map((treatmentCode, index) => ({
                sequence_number: index + 1,
                treatment_code: treatmentCode,
            })),
            counts: expectedCounts,
        },
    });
});

const updateBranchExtensionTokenLayout = asyncHandler(async (req, res) => {
    const branchId = toPositiveInt(req.selectedBranchId || req.body.branch_id);
    const layout = Array.isArray(req.body.layout) ? req.body.layout : null;
    if (!branchId || !layout) {
        throw new AppError('branch_id and layout are required', 400);
    }

    const [branchRows, mixRows] = await Promise.all([
        query(
            `SELECT id FROM master_clinic_branches WHERE id = ? AND is_active = 1 LIMIT 1`,
            [branchId]
        ),
        query(
            `SELECT t.treatment_code, m.token_count
             FROM master_token_extension_mix m
             JOIN master_treatments t ON t.id = m.fk_treatment_id
             WHERE m.is_active = 1 AND t.is_active = 1`
        ),
    ]);
    if (branchRows.length === 0) {
        throw new AppError('Branch not found or inactive', 404);
    }

    const expectedCounts = Object.fromEntries(
        mixRows.map((row) => [row.treatment_code, Number(row.token_count)])
    );
    const expectedLength = mixRows.reduce((total, row) => total + Number(row.token_count), 0);
    const normalizedLayout = layout.map((item) => (
        String(typeof item === 'string' ? item : item?.treatment_code || '').trim()
    ));
    const counts = normalizedLayout.reduce((accumulator, code) => {
        accumulator[code] = (accumulator[code] || 0) + 1;
        return accumulator;
    }, {});

    if (normalizedLayout.length !== expectedLength) {
        throw new AppError(`Extra-hour layout must contain exactly ${expectedLength} tokens`, 400);
    }
    for (const [code, count] of Object.entries(expectedCounts)) {
        if (counts[code] !== count) {
            throw new AppError(`${code} count must be exactly ${count}`, 400);
        }
    }
    if (Object.keys(counts).some((code) => expectedCounts[code] === undefined)) {
        throw new AppError('Extra-hour layout contains an unsupported treatment code', 400);
    }

    await withTransaction(async (connection) => {
        await connection.execute(
            `DELETE FROM tbl_branch_extension_token_layouts WHERE fk_branch_id = ?`,
            [branchId]
        );
        for (let index = 0; index < normalizedLayout.length; index += 1) {
            await connection.execute(
                `INSERT INTO tbl_branch_extension_token_layouts
                 (fk_branch_id, sequence_number, treatment_code)
                 VALUES (?, ?, ?)`,
                [branchId, index + 1, normalizedLayout[index]]
            );
        }
    });

    return res.status(200).json({
        success: true,
        message: 'Extra-hour token alignment saved successfully',
    });
});

const transferAppointmentByReceptionist = asyncHandler(async (req, res) => {
    const appointmentId = toPositiveInt(req.params.appointment_id);
    const newPatientId = toPositiveInt(req.body?.new_patient_id);

    if (!appointmentId) {
        throw new AppError('Valid appointment_id is required', 400);
    }

    if (!newPatientId) {
        throw new AppError('Valid new_patient_id is required', 400);
    }

    const updatedAppointment = await withTransaction(async (connection) => {
        // Fetch appointment details
        const [appointmentRows] = await connection.execute(
            `SELECT appointment_id, fk_patient_id, fk_branch_id, fk_slot_id, appointment_date, token_number, queue_status, status, is_active, checked_in_at
             FROM tbl_appointments
             WHERE appointment_id = ?
             LIMIT 1
             FOR UPDATE`,
            [appointmentId]
        );

        if (appointmentRows.length === 0) {
            throw new AppError('Appointment not found', 404);
        }

        const current = appointmentRows[0];

        if (Number(current.is_active) !== 1) {
            throw new AppError('Only active appointments can be transferred', 409);
        }

        if (current.status === 'Completed' || current.status === 'Cancelled') {
            throw new AppError('Completed or cancelled appointment cannot be transferred', 409);
        }

        if (current.checked_in_at || current.queue_status === 'CHECKED_IN') {
            throw new AppError('Checked-in appointments cannot be transferred', 409);
        }

        if (Number(current.fk_patient_id) === newPatientId) {
            throw new AppError('Appointment is already assigned to this patient', 409);
        }

        // Verify new patient exists and is active
        const [newPatientRows] = await connection.execute(
            `SELECT id, is_active
             FROM master_users
             WHERE id = ? AND role = 'PAT'
             LIMIT 1`,
            [newPatientId]
        );

        if (newPatientRows.length === 0) {
            throw new AppError('New patient not found', 404);
        }

        if (Number(newPatientRows[0].is_active) !== 1) {
            throw new AppError('New patient account is inactive', 409);
        }

        const bookingSubjectKey = getBookingSubjectKey({
            bookedForType: 'SELF',
            primaryPatientId: newPatientId,
        });

        // Update appointment
        await connection.execute(
            `UPDATE tbl_appointments
             SET fk_patient_id = ?,
                 fk_patient_family_member_id = NULL,
                 booked_for_type = 'SELF',
                 booking_subject_key = ?,
                 transferred_from_patient_id = ?,
                 updated_by = ?,
                 updated_ip = ?,
                 last_queue_event_at = NOW()
             WHERE appointment_id = ?`,
            [
                newPatientId,
                bookingSubjectKey,
                current.fk_patient_id,
                req.user.id,
                getClientIp(req),
                appointmentId,
            ]
        );

        // Recalculate queue plan
        await recalculateQueuePlan(connection, {
            branchId: Number(current.fk_branch_id),
            slotId: Number(current.fk_slot_id),
            appointmentDate: current.appointment_date,
            actorUserId: req.user.id,
            actorIp: getClientIp(req),
        });

        // Log queue event
        await logQueueEvent(connection, {
            appointmentId,
            branchId: Number(current.fk_branch_id),
            slotId: Number(current.fk_slot_id),
            appointmentDate: current.appointment_date,
            tokenNumber: current.token_number,
            eventType: 'PATIENT_TRANSFERRED',
            oldQueueStatus: current.queue_status,
            newQueueStatus: current.queue_status,
            meta: {
                old_patient_id: current.fk_patient_id,
                new_patient_id: newPatientId,
            },
            createdBy: req.user.id,
        });

        return getAppointmentDetailsById(appointmentId);
    });

    // Emit live queue event
    await emitLiveQueueEvent({
        branchId: Number(updatedAppointment.fk_branch_id),
        slotId: Number(updatedAppointment.fk_slot_id),
        appointmentDate: updatedAppointment.appointment_date,
        eventName: 'queue-updated',
        reason: 'PATIENT_TRANSFERRED',
        appointmentId,
    });

    return res.status(200).json({
        success: true,
        message: 'Patient transferred successfully',
        data: updatedAppointment,
    });
});

module.exports = {
    createAppointmentByReceptionist,
    listReceptionistAppointments,
    approveReceptionistAppointment,
    rejectReceptionistAppointment,
    getReceptionistFormData,
    listReceptionistPatients,
    getReceptionistPatientDetail,
    updateReceptionistPatient,
    listReceptionistPatientUpdateHistory,
    createReceptionistPatientFamilyMember,
    saveReceptionistAppointmentVitals,
    markAppointmentNotAvailable,
    rescheduleAppointmentByReceptionist,
    listReceptionistPrescriptions,
    getReceptionistPrescriptionDetail,
    getBranchTokenLayout,
    updateBranchTokenLayout,
    getBranchExtensionTokenLayout,
    updateBranchExtensionTokenLayout,
    bulkRejectReceptionistAppointments,
    transferAppointmentByReceptionist,
};
