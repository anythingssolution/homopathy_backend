const { query, withTransaction } = require('../../config/db');
const AppError = require('../../utils/AppError');
const asyncHandler = require('../../utils/asyncHandler');
const { normalizeRole, normalizeRoleCode } = require('../../utils/roles');
const { decorateTokenFields } = require('../../utils/tokenDisplay');
const {
    createConsultationBillForAppointment,
    PAYMENT_SETTLEMENT_TYPES,
} = require('../../services/billingService');
const { emitToRole } = require('../../utils/realtime');
const {
    BOOKED_FOR_TYPES,
    MAX_ACTIVE_FAMILY_MEMBERS,
    normalizeBookedForType,
    getAppointmentPatientColumns,
    getAppointmentPatientJoin,
    buildBookingConflictCondition,
    getBookingSubjectKey,
    getFamilyBookingSchemaState,
} = require('../../utils/patientFamily');
const {
    QUEUE_STATUS,
    ACTIVE_QUEUE_STATUSES,
    logQueueEvent,
    recalculateQueuePlan,
    emitLiveQueueEvent,
    buildDerivedLiveQueueView,
} = require('../../services/liveQueueService');
const { assertBranchDoctorAvailableForBooking } = require('../../services/doctorLeaveService');
const {
    buildFollowUpMeta,
    getTreatmentById,
    isFollowUpBookingVisitType,
    getVisitTypeCode,
    listEligibleFollowUps,
    lockEligiblePendingFollowUp,
    markPendingFollowUpBooked,
} = require('../../services/followupService');
const {
    assignAppointmentTokenNumbers,
    getBranchMaxTokenNumber,
    getPlateTokenByNumber,
    supportsTokenPlateVisitType,
} = require('../../utils/appointmentTokens');
const { buildEffectiveSlotTokenPlate } = require('../../services/slotTokenExtensionService');
const { resolveEffectiveSlotTiming } = require('../../services/slotTimeOverrideService');
const APPOINTMENT_AUID_PREFIX = 'AUID';

const getClientIp = (req) => {
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) {
        return forwarded.split(',')[0].trim();
    }

    return req.ip || req.socket?.remoteAddress || '0.0.0.0';
};

const toPositiveInt = (value) => {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) {
        return null;
    }

    return parsed;
};

const isValidDateString = (value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));

const normalizeAppointmentDateKey = (value) => {
    if (!value) {
        return '';
    }

    if (value instanceof Date) {
        return value.toISOString().split('T')[0];
    }

    return String(value).split(/[ T]/)[0];
};

const validateSlotBookingCutoff = ({ appointmentDate, slotEndTime, now = new Date() }) => {
    const normalizedAppointmentDate = String(appointmentDate || '').trim();
    const normalizedSlotEndTime = String(slotEndTime || '').trim();

    if (!isValidDateString(normalizedAppointmentDate) || !/^\d{2}:\d{2}:\d{2}$/.test(normalizedSlotEndTime)) {
        return;
    }

    const nowDatePart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

    if (normalizedAppointmentDate !== nowDatePart) {
        return;
    }

    const slotEndDateTime = new Date(`${normalizedAppointmentDate}T${normalizedSlotEndTime}`);
    if (Number.isNaN(slotEndDateTime.getTime())) {
        return;
    }

    const cutoffTime = new Date(slotEndDateTime.getTime());

    if (now >= cutoffTime) {
        throw new AppError(
            'This slot is closed for booking because less than 30 minutes are left before the slot end time',
            409
        );
    }
};

const formatDateForPublicId = (date = new Date()) => {
    const day = String(date.getDate()).padStart(2, '0');
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const year = String(date.getFullYear());

    return `${day}${month}${year}`;
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

const legacyAppointmentSelectColumns = `
    a.appointment_id, a.auid, a.fk_patient_id, a.parent_appointment_id, a.fk_branch_id, b.branch_name,
    a.fk_treatment_id, t.treatment_name, a.fk_slot_id, s.slot_name,
    COALESCE(sto.override_start_time, s.start_time) AS start_time, COALESCE(sto.override_end_time, s.end_time) AS end_time, s.default_consult_minutes, a.current_token_number AS token_number, a.appointment_date,
    a.original_token_number, a.current_token_number, a.is_shifted, a.shift_reason,
    a.not_available_at, a.booked_by_type, a.booked_by_user_id,
    a.rescheduled_from_appointment_id, a.reschedule_reason,
    a.queue_status, a.planned_start_at, a.planned_end_at, a.live_estimated_start_at, a.live_estimated_end_at,
    a.actual_called_at, a.actual_started_at, a.actual_completed_at, a.last_queue_event_at,
    a.checked_in_at, a.arrival_sequence,
    a.symptoms, a.status, a.reception_status, a.reception_approved_at, a.reception_approved_by,
    a.consultation_payment_status, a.consultation_payment_settlement_type, a.consultation_bill_id, a.payment_collected_at, a.payment_collected_by,
    a.reception_rejected_at, a.reception_rejected_by, a.reception_rejection_reason,
    a.cancelled_at, a.cancelled_by_user_id, a.cancelled_by_role,
    a.cancel_reason, a.is_active, a.created_at, a.updated_at
`;

const appointmentSelectColumns = `
    ${legacyAppointmentSelectColumns.slice(0, -1)},
    ${getAppointmentPatientColumns()}
`;

const getAppointmentSelectColumns = (familyBookingEnabled) => (
    familyBookingEnabled ? appointmentSelectColumns : legacyAppointmentSelectColumns
);

const getAppointmentPatientJoinClause = (familyBookingEnabled) => (
    familyBookingEnabled ? getAppointmentPatientJoin() : ''
);

const mapPrescriptionAggregate = (consultationRows, medicationRows, testRows = []) => {
    const medicationMap = new Map();
    const testMap = new Map();

    medicationRows.forEach((row) => {
        if (!medicationMap.has(row.consultation_id)) {
            medicationMap.set(row.consultation_id, new Map());
        }

        const consultationMedicationMap = medicationMap.get(row.consultation_id);

        if (!consultationMedicationMap.has(row.consultation_medication_id)) {
            consultationMedicationMap.set(row.consultation_medication_id, {
                consultation_medication_id: row.consultation_medication_id,
                medicine_type: row.medicine_type,
                medicine_value: row.medicine_value,
                remark: row.remark,
                added_by_role: row.added_by_role || 'DOCTOR',
                doses: [],
            });
        }

        if (row.medication_dosage_id) {
            consultationMedicationMap.get(row.consultation_medication_id).doses.push({
                medication_dosage_id: row.medication_dosage_id,
                dose_label: row.dose_label,
                sort_order: row.sort_order,
                times_per_day: row.times_per_day,
                balls_per_dose: row.balls_per_dose,
                instructions: row.instructions,
            });
        }
    });

    testRows.forEach((row) => {
        if (!testMap.has(row.consultation_id)) {
            testMap.set(row.consultation_id, []);
        }

        testMap.get(row.consultation_id).push({
            consultation_test_id: row.consultation_test_id,
            test_name: row.test_name,
            amount: row.amount,
        });
    });

    return new Map(
        consultationRows.map((row) => [
            Number(row.appointment_id),
            {
                consultation_id: row.consultation_id,
                appointment_id: row.appointment_id,
                doctor_id: row.doctor_id,
                doctor_uuid: row.doctor_uuid,
                doctor_name: row.doctor_name,
                workflow_status: row.workflow_status,
                symptoms: row.symptoms,
                treatment_advice: row.treatment_advice,
                medication_duration_days: row.medication_duration_days,
                created_at: row.created_at,
                updated_at: row.updated_at,
                medications: Array.from((medicationMap.get(row.consultation_id) || new Map()).values()),
                tests: testMap.get(row.consultation_id) || [],
            },
        ])
    );
};

const resolveEligibleFollowUpSubject = async ({ req }) => {
    const requesterRoleCode = normalizeRoleCode(req.user?.role_code || req.user?.role);

    if (requesterRoleCode === 'REC') {
        const patientId = toPositiveInt(req.query.patient_id);
        const familyMemberIdParam = req.query.family_member_id;
        const familyMemberId = familyMemberIdParam === '' || familyMemberIdParam === undefined || familyMemberIdParam === null
            ? undefined
            : (String(familyMemberIdParam).trim().toLowerCase() === 'null' ? null : toPositiveInt(familyMemberIdParam));

        if (!patientId) {
            throw new AppError('patient_id is required for receptionist eligible follow-ups lookup', 400);
        }

        if (familyMemberIdParam !== undefined && familyMemberId === undefined) {
            throw new AppError('family_member_id must be a positive integer or null', 400);
        }

        const patientRows = await query(
            `SELECT id, role, is_active
             FROM master_users
             WHERE id = ?
             LIMIT 1`,
            [patientId]
        );

        if (patientRows.length === 0) {
            throw new AppError('Selected patient not found', 404);
        }

        if (normalizeRoleCode(patientRows[0].role) !== 'PAT') {
            throw new AppError('Selected user is not a patient account', 409);
        }

        if (Number(patientRows[0].is_active) !== 1) {
            throw new AppError('Selected patient is inactive', 409);
        }

        return {
            patientId,
            familyMemberId,
            requested_by_role: 'REC',
        };
    }

    const familyMemberIdParam = req.query.family_member_id;
    const familyMemberId = familyMemberIdParam === '' || familyMemberIdParam === undefined || familyMemberIdParam === null
        ? undefined
        : (String(familyMemberIdParam).trim().toLowerCase() === 'null' ? null : toPositiveInt(familyMemberIdParam));

    if (familyMemberIdParam !== undefined && familyMemberId === undefined) {
        throw new AppError('family_member_id must be a positive integer or null', 400);
    }

    return {
        patientId: req.user.id,
        familyMemberId,
        requested_by_role: 'PAT',
    };
};

const getAppointmentFormData = asyncHandler(async (req, res) => {
    const branchFilter = toPositiveInt(req.query.branch_id);
    const familyBookingSchema = await getFamilyBookingSchemaState({ queryFn: query });

    const [branches, rawTreatments, familyMembers] = await Promise.all([
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
        familyBookingSchema.enabled ? query(
            `SELECT
                id AS family_member_id,
                full_name,
                age,
                gender,
                relationship,
                description,
                is_active,
                created_at,
                updated_at
             FROM tbl_patient_family_members
             WHERE fk_primary_patient_id = ?
               AND is_active = 1
             ORDER BY created_at ASC, id ASC`,
            [req.user.id]
        ) : Promise.resolve([]),
    ]);
    const followUpMeta = buildFollowUpMeta(rawTreatments);

    const slotsParams = [];
    let slotsSql = `SELECT id, fk_branch_id, slot_name, start_time, end_time, COALESCE(default_consult_minutes, 15) AS default_consult_minutes
                    FROM master_slots
                    WHERE is_active = 1`;

    if (branchFilter) {
        slotsSql += ' AND fk_branch_id = ?';
        slotsParams.push(branchFilter);
    }

    slotsSql += ' ORDER BY start_time ASC';

    const slots = await query(slotsSql, slotsParams);

    return res.status(200).json({
        success: true,
        message: 'Appointment form data fetched successfully',
        data: {
            branches,
            treatments: followUpMeta.treatments,
            slots,
            family_members: familyMembers,
            meta: {
                statuses: ['Pending', 'Confirmed', 'Completed', 'Cancelled'],
                token_number_range: {
                    min: 1,
                    max: branchFilter ? getBranchMaxTokenNumber(branchFilter) : getBranchMaxTokenNumber(),
                },
                booking_for_options: familyBookingSchema.enabled ? Object.values(BOOKED_FOR_TYPES) : [BOOKED_FOR_TYPES.SELF],
                max_active_family_members: familyBookingSchema.enabled ? MAX_ACTIVE_FAMILY_MEMBERS : 0,
                family_member_booking_enabled: familyBookingSchema.enabled,
                follow_up_rules: followUpMeta.meta,
            },
        },
    });
});

const getBookingTokenPlate = asyncHandler(async (req, res) => {
    const branchId = toPositiveInt(req.query.branch_id ?? req.query.fk_branch_id);
    const slotId = toPositiveInt(req.query.slot_id ?? req.query.fk_slot_id);
    const treatmentId = toPositiveInt(req.query.treatment_id ?? req.query.fk_treatment_id);
    const appointmentDate = String(req.query.appointment_date || '').trim();

    if (!branchId || !slotId || !treatmentId || !appointmentDate) {
        throw new AppError('branch_id, slot_id, treatment_id and appointment_date are required', 400);
    }

    if (!isValidDateString(appointmentDate)) {
        throw new AppError('appointment_date must be in YYYY-MM-DD format', 400);
    }

    if (req.selectedBranchId && Number(req.selectedBranchId) !== branchId) {
        throw new AppError('You can access token plate only for the selected branch', 403);
    }

    const [branchRows, slotRows, treatmentRows, bookedAppointments] = await Promise.all([
        query(
            `SELECT id
             FROM master_clinic_branches
             WHERE id = ? AND is_active = 1
             LIMIT 1`,
            [branchId]
        ),
        query(
            `SELECT id, fk_branch_id, slot_name, start_time, end_time
             FROM master_slots
             WHERE id = ? AND is_active = 1
             LIMIT 1`,
            [slotId]
        ),
        query(
            `SELECT id, treatment_code, treatment_name
             FROM master_treatments
             WHERE id = ? AND is_active = 1
             LIMIT 1`,
            [treatmentId]
        ),
        query(
            `SELECT token_number, current_token_number
             FROM tbl_appointments
             WHERE fk_branch_id = ?
               AND fk_slot_id = ?
               AND appointment_date = ?
               AND is_active = 1
               AND status <> 'Cancelled'
               AND COALESCE(reception_status, '') <> 'REJECTED_BY_RECEPTION'
               AND COALESCE(queue_status, '') <> 'CANCELLED'`,
            [branchId, slotId, appointmentDate]
        ),
    ]);

    if (branchRows.length === 0) {
        throw new AppError('Selected branch not found or inactive', 404);
    }

    if (slotRows.length === 0) {
        throw new AppError('Selected slot not found or inactive', 404);
    }

    if (treatmentRows.length === 0) {
        throw new AppError('Selected treatment not found or inactive', 404);
    }

    if (Number(slotRows[0].fk_branch_id) !== branchId) {
        throw new AppError('Selected slot does not belong to the selected branch', 400);
    }

    const visitTypeCode = getVisitTypeCode({
        treatmentId,
        treatmentName: treatmentRows[0].treatment_name,
        treatmentCode: treatmentRows[0].treatment_code,
    });
    const bookedTokenNumbers = new Set(
        bookedAppointments
            .map((appointment) => appointment.token_number)
            .map((value) => Number(value))
            .filter((value) => Number.isInteger(value) && value > 0)
    );

    const tokens = await buildEffectiveSlotTokenPlate({
        executor: query,
        branchId,
        slotId,
        appointmentDate,
        slotStartTime: slotRows[0].start_time,
        bookedTokenNumbers,
        selectedVisitTypeCode: supportsTokenPlateVisitType(visitTypeCode) ? visitTypeCode : null,
    });
    const effectiveTiming = await resolveEffectiveSlotTiming({
        executor: query,
        branchId,
        slotId,
        appointmentDate,
    });

    return res.status(200).json({
        success: true,
        message: 'Booking token plate fetched successfully',
        data: {
            branch_id: branchId,
            slot_id: slotId,
            appointment_date: appointmentDate,
            treatment_id: treatmentId,
            treatment_name: treatmentRows[0].treatment_name,
            selected_visit_type_code: visitTypeCode,
            selected_visit_type_supported: supportsTokenPlateVisitType(visitTypeCode),
            slot: {
                id: slotRows[0].id,
                slot_name: slotRows[0].slot_name,
                start_time: effectiveTiming.effectiveStartTime,
                end_time: effectiveTiming.effectiveEndTime,
                default_start_time: effectiveTiming.defaultStartTime,
                default_end_time: effectiveTiming.defaultEndTime,
                has_time_override: effectiveTiming.hasOverride,
            },
            tokens,
        },
    });
});

const listEligibleFollowUpsForBooking = asyncHandler(async (req, res) => {
    const subject = await resolveEligibleFollowUpSubject({ req });
    const rows = await listEligibleFollowUps({
        patientId: subject.patientId,
        familyMemberId: subject.familyMemberId,
    });

    return res.status(200).json({
        success: true,
        message: 'Eligible follow-ups fetched successfully',
        data: rows,
        meta: {
            total: rows.length,
            patient_id: subject.patientId,
            family_member_id: subject.familyMemberId === undefined ? null : subject.familyMemberId,
            requested_by_role: subject.requested_by_role,
        },
    });
});

const PATIENT_FOLLOW_UP_BOOKING_MESSAGE = 'Only doctor-advised follow-up visits can be booked here.';

const createAppointment = asyncHandler(async (req, res) => {
    const {
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

    const branchId = toPositiveInt(fk_branch_id);
    const treatmentId = toPositiveInt(fk_treatment_id);
    const slotId = toPositiveInt(fk_slot_id);

    if (!branchId || !treatmentId || !slotId || !appointment_date) {
        throw new AppError('fk_branch_id, fk_treatment_id, fk_slot_id and appointment_date are required', 400);
    }

    if (!isValidDateString(appointment_date)) {
        throw new AppError('appointment_date must be in YYYY-MM-DD format', 400);
    }

    const appointmentDateObj = new Date(`${appointment_date}T00:00:00Z`);
    if (Number.isNaN(appointmentDateObj.getTime())) {
        throw new AppError('appointment_date is invalid', 400);
    }

    const todayUtc = new Date();
    const todayOnly = new Date(Date.UTC(todayUtc.getUTCFullYear(), todayUtc.getUTCMonth(), todayUtc.getUTCDate()));

    if (appointmentDateObj < todayOnly) {
        throw new AppError('appointment_date cannot be in the past', 400);
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

    const createdIp = getClientIp(req);
    const familyBookingSchema = await getFamilyBookingSchemaState({ queryFn: query });

    if (!familyBookingSchema.enabled && bookedForType === BOOKED_FOR_TYPES.FAMILY_MEMBER) {
        throw new AppError('Family member booking is not available until the family-member migration is applied', 409);
    }

    let parentAppointmentId = null;
    if (parent_appointment_id !== null && parent_appointment_id !== undefined && parent_appointment_id !== '') {
        parentAppointmentId = toPositiveInt(parent_appointment_id);
        if (!parentAppointmentId) {
            throw new AppError('parent_appointment_id must be a positive integer', 400);
        }
    }

    const result = await withTransaction(async (connection) => {
        const [branchRows] = await connection.execute(
            'SELECT id FROM master_clinic_branches WHERE id = ? AND is_active = 1 LIMIT 1',
            [branchId]
        );
        const [treatmentRows] = await connection.execute(
            'SELECT id, consultation_fee FROM master_treatments WHERE id = ? AND is_active = 1 LIMIT 1',
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

        if (familyBookingSchema.enabled && bookedForType === BOOKED_FOR_TYPES.FAMILY_MEMBER) {
            const [familyMemberRows] = await connection.execute(
                `SELECT id
                 FROM tbl_patient_family_members
                 WHERE id = ?
                   AND fk_primary_patient_id = ?
                   AND is_active = 1
                 LIMIT 1`,
                [familyMemberId, req.user.id]
            );

            if (familyMemberRows.length === 0) {
                throw new AppError('Selected family member not found for this patient account', 404);
            }
        }

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

        let conflictingPatientAppointments;
        if (familyBookingSchema.enabled) {
            const conflictCondition = buildBookingConflictCondition({
                bookedForType,
                primaryPatientId: req.user.id,
                familyMemberId,
            });

            [conflictingPatientAppointments] = await connection.execute(
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
        } else {
            [conflictingPatientAppointments] = await connection.execute(
                `SELECT appointment_id
                 FROM tbl_appointments
                 WHERE fk_patient_id = ?
                   AND appointment_date = ?
                   AND is_active = 1
                   AND status IN ('Pending', 'Confirmed')
                   AND COALESCE(reception_status, '') <> 'REJECTED_BY_RECEPTION'
                   AND COALESCE(queue_status, '') <> 'CANCELLED'
                 FOR UPDATE`,
                [req.user.id, appointment_date]
            );
        }

        if (conflictingPatientAppointments.length > 0) {
            throw new AppError(
                'The selected patient or family member already has an unresolved active appointment for the selected date',
                409
            );
        }

        let eligiblePendingFollowUp = null;
        if (isFollowUpBookingVisitType(visitTypeCode)) {
            if (!parentAppointmentId) {
                throw new AppError(PATIENT_FOLLOW_UP_BOOKING_MESSAGE, 400);
            }

            eligiblePendingFollowUp = await lockEligiblePendingFollowUp({
                connection,
                parentAppointmentId,
                patientId: req.user.id,
                familyMemberId,
            });

            if (!eligiblePendingFollowUp) {
                throw new AppError(PATIENT_FOLLOW_UP_BOOKING_MESSAGE, 409);
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
        let insertResult;
        if (familyBookingSchema.enabled) {
            const bookingSubjectKey = getBookingSubjectKey({
                bookedForType,
                primaryPatientId: req.user.id,
                familyMemberId,
            });

            [insertResult] = await connection.execute(
                `INSERT INTO tbl_appointments
                 (auid, fk_patient_id, fk_patient_family_member_id, parent_appointment_id, booked_for_type, booking_subject_key, fk_branch_id, fk_treatment_id, assigned_visit_type_code, assigned_slot_duration_minutes, fk_slot_id, token_number, original_token_number, current_token_number, appointment_date, symptoms, status, reception_status, booked_by_type, booked_by_user_id, queue_status, last_queue_event_at, is_active, created_by, updated_by, created_ip, updated_ip)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Pending', 'PENDING_AT_RECEPTION', 'SELF', ?, ?, NOW(), 1, ?, ?, ?, ?)`,
                [
                    appointmentAuid,
                    req.user.id,
                    familyMemberId,
                    parentAppointmentId,
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
        } else {
            [insertResult] = await connection.execute(
                `INSERT INTO tbl_appointments
                 (auid, fk_patient_id, parent_appointment_id, fk_branch_id, fk_treatment_id, assigned_visit_type_code, assigned_slot_duration_minutes, fk_slot_id, token_number, original_token_number, current_token_number, appointment_date, symptoms, status, reception_status, booked_by_type, booked_by_user_id, queue_status, last_queue_event_at, is_active, created_by, updated_by, created_ip, updated_ip)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Pending', 'PENDING_AT_RECEPTION', 'SELF', ?, ?, NOW(), 1, ?, ?, ?, ?)`,
                [
                    appointmentAuid,
                    req.user.id,
                    parentAppointmentId,
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
        }

        await createConsultationBillForAppointment({
            connection,
            appointmentId: insertResult.insertId,
            patientId: req.user.id,
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
                booked_by_type: 'SELF',
                booked_for_type: familyBookingSchema.enabled ? bookedForType : BOOKED_FOR_TYPES.SELF,
                fk_patient_family_member_id: familyBookingSchema.enabled ? familyMemberId : null,
                parent_appointment_id: parentAppointmentId,
            },
        });

        if (eligiblePendingFollowUp?.id) {
            await markPendingFollowUpBooked({
                connection,
                pendingFollowupId: Number(eligiblePendingFollowUp.id),
            });
        }

        return insertResult;
    });

    const appointmentRows = await query(
        `SELECT ${getAppointmentSelectColumns(familyBookingSchema.enabled)}
         FROM tbl_appointments a
         JOIN master_clinic_branches b ON b.id = a.fk_branch_id
         JOIN master_treatments t ON t.id = a.fk_treatment_id
         JOIN master_slots s ON s.id = a.fk_slot_id
         LEFT JOIN tbl_doctor_slot_time_overrides sto
           ON sto.fk_branch_id = a.fk_branch_id
          AND sto.fk_slot_id = a.fk_slot_id
          AND sto.appointment_date = a.appointment_date
          AND sto.status = 'ACTIVE'
         ${getAppointmentPatientJoinClause(familyBookingSchema.enabled)}
         WHERE a.appointment_id = ?
         LIMIT 1`,
        [result.insertId]
    );
    const createdAppointment = decorateTokenFields(appointmentRows[0] || null);

    await emitLiveQueueEvent({
        branchId,
        slotId,
        appointmentDate: appointment_date,
        eventName: 'queue-updated',
        reason: 'APPOINTMENT_CREATED',
        appointmentId: result.insertId,
    });

    emitToRole('DOC', 'doctor.appointments.updated', {
        reason: 'APPOINTMENT_CREATED',
        source: 'PATIENT_BOOKING',
        appointment: createdAppointment,
    });

    return res.status(201).json({
        success: true,
        message: 'Appointment created successfully',
        data: createdAppointment,
    });
});

const listMyAppointments = asyncHandler(async (req, res) => {
    const actorRole = normalizeRole(req.user?.role || req.user?.role_code) || 'patient';
    const familyBookingSchema = await getFamilyBookingSchemaState({ queryFn: query });
    const shouldApplyWorkflowStatusFilter = actorRole !== 'patient';
    const allowedWorkflowStatuses = [
        'READY_FOR_RECEPTION',
        'APPROVED_BY_RECEPTION',
        'READY_FOR_MEDICAL',
        'PROCESSED_BY_MEDICAL',
        'COMPLETED_NO_PRESCRIPTION',
    ];

    const appointments = await query(
        `SELECT ${getAppointmentSelectColumns(familyBookingSchema.enabled)}
         FROM tbl_appointments a
         JOIN master_clinic_branches b ON b.id = a.fk_branch_id
         JOIN master_treatments t ON t.id = a.fk_treatment_id
         JOIN master_slots s ON s.id = a.fk_slot_id
         LEFT JOIN tbl_doctor_slot_time_overrides sto
           ON sto.fk_branch_id = a.fk_branch_id
          AND sto.fk_slot_id = a.fk_slot_id
          AND sto.appointment_date = a.appointment_date
          AND sto.status = 'ACTIVE'
         ${getAppointmentPatientJoinClause(familyBookingSchema.enabled)}
         WHERE a.fk_patient_id = ?
         ORDER BY a.appointment_date DESC, a.created_at DESC`,
        [req.user.id]
    );
    const decoratedAppointments = appointments.map((appointment) => decorateTokenFields(appointment));
    const activeQueueDecorations = new Map();
    const queueGroups = new Map();

    for (const appointment of decoratedAppointments) {
        if (!ACTIVE_QUEUE_STATUSES.includes(appointment.queue_status)) {
            continue;
        }

        const queueGroupKey = [
            Number(appointment.fk_branch_id || 0),
            Number(appointment.fk_slot_id || 0),
            normalizeAppointmentDateKey(appointment.appointment_date),
        ].join(':');

        if (!queueGroups.has(queueGroupKey)) {
            queueGroups.set(queueGroupKey, []);
        }

        queueGroups.get(queueGroupKey).push(appointment);
    }

    for (const groupedAppointments of queueGroups.values()) {
        const derivedQueueView = buildDerivedLiveQueueView({
            queueItems: groupedAppointments,
        });

        for (const queueItem of derivedQueueView.items || []) {
            activeQueueDecorations.set(Number(queueItem.appointment_id), {
                queue_bucket: queueItem.queue_bucket || null,
                live_queue_position: queueItem.live_queue_position ?? null,
                ready_queue_position: queueItem.ready_queue_position ?? null,
            });
        }
    }

    const appointmentIds = decoratedAppointments.map((appointment) => Number(appointment.appointment_id)).filter(Boolean);
    let prescriptionByAppointmentId = new Map();

    if (appointmentIds.length > 0) {
        const placeholders = appointmentIds.map(() => '?').join(', ');

        const consultationParams = [...appointmentIds];
        let consultationSql = `SELECT
                c.id AS consultation_id,
                c.appointment_id,
                c.doctor_id,
                d.uuid AS doctor_uuid,
                d.full_name AS doctor_name,
                c.symptoms,
                c.treatment_advice,
                c.medication_duration_days,
                c.workflow_status,
                c.created_at,
                c.updated_at
             FROM tbl_consultations c
             JOIN master_users d ON d.id = c.doctor_id
             WHERE c.appointment_id IN (${placeholders})`;

        if (shouldApplyWorkflowStatusFilter) {
            const workflowPlaceholders = allowedWorkflowStatuses.map(() => '?').join(', ');
            consultationSql += ` AND c.workflow_status IN (${workflowPlaceholders})`;
            consultationParams.push(...allowedWorkflowStatuses);
        }

        const consultationRows = await query(
            consultationSql,
            consultationParams
        );

        if (consultationRows.length > 0) {
            const consultationIds = consultationRows.map((row) => Number(row.consultation_id)).filter(Boolean);
            const medicationPlaceholders = consultationIds.map(() => '?').join(', ');

            const medicationRows = await query(
                `SELECT
                    cm.consultation_id,
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
                 WHERE cm.consultation_id IN (${medicationPlaceholders})
                 ORDER BY cm.id ASC, COALESCE(md.sort_order, 999) ASC, md.id ASC`,
                consultationIds
            );

            const testRows = await query(
                `SELECT
                    consultation_id,
                    id AS consultation_test_id,
                    test_name,
                    amount
                 FROM tbl_consultation_tests
                 WHERE consultation_id IN (${medicationPlaceholders})
                 ORDER BY id ASC`,
                consultationIds
            );

            prescriptionByAppointmentId = mapPrescriptionAggregate(consultationRows, medicationRows, testRows);
        }
    }

    const enrichedAppointments = decoratedAppointments.map((appointment) => ({
        ...appointment,
        ...(activeQueueDecorations.get(Number(appointment.appointment_id)) || {}),
        prescription: prescriptionByAppointmentId.get(Number(appointment.appointment_id)) || null,
    }));

    return res.status(200).json({
        success: true,
        message: 'Appointments fetched successfully',
        data: enrichedAppointments,
    });
});

const cancelAppointment = asyncHandler(async (req, res) => {
    const appointmentId = toPositiveInt(req.params.appointment_id);
    const { cancel_reason = null } = req.body || {};

    if (!appointmentId) {
        throw new AppError('Valid appointment_id is required', 400);
    }

    const actorRole = normalizeRole(req.user?.role) || 'patient';
    const actorRoleCode = normalizeRoleCode(req.user?.role_code) || 'PAT';
    const normalizedCancelReason = cancel_reason ? String(cancel_reason).trim() : null;
    const familyBookingSchema = await getFamilyBookingSchemaState({ queryFn: query });

    const updatedAppointment = await withTransaction(async (connection) => {
        const [appointmentRows] = await connection.execute(
            `SELECT appointment_id, auid, fk_patient_id, fk_branch_id, fk_slot_id, appointment_date, current_token_number, queue_status, status, is_active
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

        if (actorRole === 'patient' && Number(appointment.fk_patient_id) !== Number(req.user.id)) {
            throw new AppError('You can cancel only your own appointment', 403);
        }

        if (appointment.status === 'Cancelled' || Number(appointment.is_active) === 0) {
            throw new AppError('Appointment is already cancelled', 409);
        }

        if (appointment.status === 'Completed') {
            throw new AppError('Completed appointment cannot be cancelled', 409);
        }

        const [sameQueueRows] = await connection.execute(
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
                appointment.fk_branch_id,
                appointment.fk_slot_id,
                appointment.appointment_date,
                appointmentId,
                appointment.current_token_number,
            ]
        );

        for (const row of sameQueueRows) {
            await connection.execute(
                `UPDATE tbl_appointments
                 SET current_token_number = current_token_number - 1,
                     updated_by = ?,
                     updated_ip = ?
                 WHERE appointment_id = ?`,
                [req.user.id, getClientIp(req), row.appointment_id]
            );
        }

        await connection.execute(
            `UPDATE tbl_appointments
             SET status = 'Cancelled',
                 is_active = 0,
                 queue_status = ?,
                 cancelled_at = NOW(),
                 cancelled_by_user_id = ?,
                 cancelled_by_role = ?,
                 cancel_reason = ?,
                 last_queue_event_at = NOW(),
                 updated_by = ?,
                 updated_ip = ?
             WHERE appointment_id = ?`,
            [
                QUEUE_STATUS.CANCELLED,
                req.user.id,
                actorRoleCode,
                normalizedCancelReason,
                req.user.id,
                getClientIp(req),
                appointmentId,
            ]
        );

        await recalculateQueuePlan(connection, {
            branchId: Number(appointment.fk_branch_id),
            slotId: Number(appointment.fk_slot_id),
            appointmentDate: appointment.appointment_date,
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
                appointment.fk_branch_id,
                appointment.fk_slot_id,
                appointment.appointment_date,
            ]
        );

        await logQueueEvent(connection, {
            appointmentId,
            branchId: Number(appointment.fk_branch_id),
            slotId: Number(appointment.fk_slot_id),
            appointmentDate: appointment.appointment_date,
            tokenNumber: Number(appointment.current_token_number),
            eventType: 'APPOINTMENT_CANCELLED',
            oldQueueStatus: appointment.queue_status,
            newQueueStatus: QUEUE_STATUS.CANCELLED,
            createdBy: req.user.id,
            meta: {
                cancelled_by_role: actorRoleCode,
                cancel_reason: normalizedCancelReason,
            },
        });

        const [updatedRows] = await connection.execute(
            `SELECT ${getAppointmentSelectColumns(familyBookingSchema.enabled)}
             FROM tbl_appointments a
             JOIN master_clinic_branches b ON b.id = a.fk_branch_id
             JOIN master_treatments t ON t.id = a.fk_treatment_id
             JOIN master_slots s ON s.id = a.fk_slot_id
             LEFT JOIN tbl_doctor_slot_time_overrides sto
               ON sto.fk_branch_id = a.fk_branch_id
              AND sto.fk_slot_id = a.fk_slot_id
              AND sto.appointment_date = a.appointment_date
              AND sto.status = 'ACTIVE'
             ${getAppointmentPatientJoinClause(familyBookingSchema.enabled)}
             WHERE a.appointment_id = ?
             LIMIT 1`,
            [appointmentId]
        );

        return decorateTokenFields(updatedRows[0] || null);
    });

    await emitLiveQueueEvent({
        branchId: Number(updatedAppointment.fk_branch_id),
        slotId: Number(updatedAppointment.fk_slot_id),
        appointmentDate: updatedAppointment.appointment_date,
        eventName: 'appointment-cancelled',
        reason: 'APPOINTMENT_CANCELLED',
        appointmentId,
    });

    return res.status(200).json({
        success: true,
        message: 'Appointment cancelled successfully',
        data: updatedAppointment,
    });
});

module.exports = {
    getAppointmentFormData,
    getBookingTokenPlate,
    listEligibleFollowUpsForBooking,
    createAppointment,
    listMyAppointments,
    cancelAppointment,
};
