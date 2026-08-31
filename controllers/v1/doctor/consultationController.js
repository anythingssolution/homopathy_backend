const { query } = require('../../../config/db');
const {
    withTransaction,
    AppError,
    asyncHandler,
    createNotificationsForRole,
    markAppointmentQueueCompleted,
    emitLiveQueueEvent,
    getDoctorAppointmentById,
    getConsultationAggregateByAppointmentId,
    getMedicalPricingAggregateByConsultationId,
    enrichAppointmentChainWithConsultationData,
    validateConsultationPayload,
    saveTextMedicineRemarkSuggestion,
    saveUniversalRemarkSuggestion,
    parseTextMedicineDisplayParts,
    upsertMasterTextMedicine,
    upsertDoctorManualVariant,
} = require('./shared');
const {
    createNextFollowUpIfNeeded,
    getAppointmentChain,
    getVisitTypeCode,
} = require('../../../services/followupService');
const {
    scheduleAutoCallNext,
    DEFAULT_AUTO_CALL_DELAY_MS,
} = require('../../../services/liveQueueAutomationService');
const {
    QUEUE_STATUS,
    formatDateTimeForSql,
} = require('../../../services/liveQueueService');
const {
    scheduleFollowUpReminders,
    cancelScheduledReminders,
} = require('../../../services/whatsappAutomationService');

const executeRows = async (executor, sql, params = []) => {
    const result = await executor(sql, params);
    return Array.isArray(result?.[0]) ? result[0] : result;
};

const getConsultationEditAccess = async (executor, consultationId) => {
    const [consultation] = await executeRows(
        executor,
        `SELECT id, workflow_status
         FROM tbl_consultations
         WHERE id = ?
         LIMIT 1`,
        [consultationId]
    );

    if (!consultation) {
        return {
            can_edit_before_dispense: false,
            edit_lock_reason: 'Consultation not found',
        };
    }

    if (!['READY_FOR_MEDICAL', 'COMPLETED_NO_PRESCRIPTION'].includes(consultation.workflow_status)) {
        return {
            can_edit_before_dispense: false,
            edit_lock_reason: 'Medical has already processed this prescription',
            workflow_status: consultation.workflow_status,
        };
    }

    const paidBillRows = await executeRows(
        executor,
        `SELECT id
         FROM tbl_bills
         WHERE consultation_id = ?
           AND bill_type = 'MEDICATION'
           AND status = 'ACTIVE'
           AND (payment_status = 'PAID' OR paid_amount > 0)
         LIMIT 1`,
        [consultationId]
    );

    if (paidBillRows.length > 0) {
        return {
            can_edit_before_dispense: false,
            edit_lock_reason: 'Medication bill payment has already started',
            workflow_status: consultation.workflow_status,
        };
    }

    const dispensingRequestRows = await executeRows(
        executor,
        `SELECT id
         FROM tbl_medical_dispensing_requests
         WHERE consultation_id = ?
           AND request_type IN ('SAVE', 'PROCESS')
         LIMIT 1`,
        [consultationId]
    );

    if (dispensingRequestRows.length > 0) {
        return {
            can_edit_before_dispense: false,
            edit_lock_reason: 'Medical dispensing changes have already been saved',
            workflow_status: consultation.workflow_status,
        };
    }

    const dispensingEventRows = await executeRows(
        executor,
        `SELECT e.id
         FROM tbl_medical_dispensing_item_events e
         JOIN tbl_medical_prescription_pricing_items i ON i.id = e.pricing_item_id
         JOIN tbl_medical_prescription_pricing p ON p.id = i.pricing_id
         WHERE p.consultation_id = ?
         LIMIT 1`,
        [consultationId]
    );

    if (dispensingEventRows.length > 0) {
        return {
            can_edit_before_dispense: false,
            edit_lock_reason: 'Medical dispensing status has already changed',
            workflow_status: consultation.workflow_status,
        };
    }

    const medicalAddedRows = await executeRows(
        executor,
        `SELECT id
         FROM tbl_consultation_medications
         WHERE consultation_id = ?
           AND added_by_role = 'MEDICAL'
         LIMIT 1`,
        [consultationId]
    );

    if (medicalAddedRows.length > 0) {
        return {
            can_edit_before_dispense: false,
            edit_lock_reason: 'Medical has already added medicines',
            workflow_status: consultation.workflow_status,
        };
    }

    return {
        can_edit_before_dispense: true,
        edit_lock_reason: null,
        workflow_status: consultation.workflow_status,
    };
};

const createConsultation = asyncHandler(async (req, res) => {
    const {
        appointmentId,
        medicationDurationDays,
        followUpAfterDays,
        repeatedFromConsultationId,
        consultationMode,
        oxygenSaturation,
        bloodPressure,
        patientHeight,
        patientWeight,
        symptoms,
        diagnosis,
        treatmentAdvice,
        hasNoAdvice,
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
        universalRemark,
        universalRemarkHi,
        followUpChainClosed,
        isRepeat,
        isSame,
        repeatMonths,
        sameMonths,
        medications,
        tests,
        totalAmount,
    } = validateConsultationPayload(req.body);

    let createdConsultationId = null;
    let pendingFollowUp = null;
    let shouldNotifyMedical = false;
    let updatedExistingConsultation = false;

    const queueCompletionContext = await withTransaction(async (connection) => {
        const [appointmentRows] = await connection.execute(
            `SELECT
                a.appointment_id,
                a.parent_appointment_id,
                a.fk_branch_id,
                a.status,
                a.is_active,
                a.queue_status,
                a.actual_called_at,
                a.reception_status,
                a.consultation_payment_status,
                t.id AS treatment_id,
                t.treatment_code,
                t.treatment_name
             FROM tbl_appointments a
             JOIN master_treatments t ON t.id = a.fk_treatment_id
             WHERE a.appointment_id = ?
             LIMIT 1
             FOR UPDATE`,
            [appointmentId]
        );

        if (appointmentRows.length === 0) {
            throw new AppError('Appointment not found', 404);
        }

        const appointment = appointmentRows[0];

        if (req.selectedBranchId && Number(appointment.fk_branch_id) !== Number(req.selectedBranchId)) {
            throw new AppError('You can create consultation only for the selected branch', 403);
        }
        if (Number(appointment.is_active) !== 1 || appointment.status === 'Cancelled') {
            throw new AppError('Consultation cannot be created for a cancelled or inactive appointment', 409);
        }
        if (appointment.reception_status !== 'APPROVED_BY_RECEPTION') {
            throw new AppError('Consultation can only be created after receptionist approval', 409);
        }
        if (appointment.consultation_payment_status !== 'PAID') {
            throw new AppError('Consultation can only be created after consultation payment is collected', 409);
        }
        const isLiveQueueCompletion = (
            appointment.queue_status === QUEUE_STATUS.IN_PROGRESS
            || (
                appointment.queue_status === QUEUE_STATUS.WAITING
                && appointment.actual_called_at
            )
        );

        const [existingConsultationRows] = await connection.execute(
            `SELECT id
             FROM tbl_consultations
             WHERE appointment_id = ?
             LIMIT 1
             FOR UPDATE`,
            [appointmentId]
        );

        const isUpdating = existingConsultationRows.length > 0;
        updatedExistingConsultation = isUpdating;

        if (repeatedFromConsultationId) {
            const currentVisitType = getVisitTypeCode({
                treatmentId: appointment.treatment_id,
                treatmentName: appointment.treatment_name,
                treatmentCode: appointment.treatment_code,
            });

            if (currentVisitType !== 'FOLLOW_UP_VISIT' || !appointment.parent_appointment_id) {
                throw new AppError('Repeat treatment is available only for follow-up visits', 409);
            }

            const [sourceRows] = await connection.execute(
                `SELECT c.id
                 FROM tbl_consultations c
                 WHERE c.id = ?
                   AND c.appointment_id = ?
                 LIMIT 1
                 FOR UPDATE`,
                [repeatedFromConsultationId, appointment.parent_appointment_id]
            );

            if (sourceRows.length === 0) {
                throw new AppError('Repeat treatment source must be the parent consultation', 409);
            }
        }

        const shouldSendToMedical = medications.length > 0 || tests.length > 0;
        const consultationWorkflowStatus = shouldSendToMedical
            ? 'READY_FOR_MEDICAL'
            : 'COMPLETED_NO_PRESCRIPTION';
        shouldNotifyMedical = shouldSendToMedical && !isUpdating;

        if (isUpdating) {
            createdConsultationId = existingConsultationRows[0].id;
            const editAccess = await getConsultationEditAccess(
                (sql, params) => connection.execute(sql, params),
                createdConsultationId
            );

            if (!editAccess.can_edit_before_dispense) {
                throw new AppError(editAccess.edit_lock_reason || 'This consultation can no longer be edited', 409);
            }
            shouldNotifyMedical = shouldSendToMedical
                && editAccess.workflow_status === 'COMPLETED_NO_PRESCRIPTION';

            await connection.execute(
                `UPDATE tbl_consultations
                 SET doctor_id = ?, symptoms = ?, treatment_advice = ?, medication_duration_days = ?,
                     follow_up_chain_closed = ?, follow_up_after_days = ?, repeated_from_consultation_id = ?,
                     is_repeat = ?, is_same = ?, repeat_months = ?, same_months = ?,
                     consultation_mode = ?, oxygen_saturation = ?, blood_pressure = ?, patient_height = ?,
                     patient_weight = ?, occupation = ?, history_present_illness = ?, history_past_illness = ?,
                     family_history = ?, allergies_history = ?, gynecological_history = ?, personal_social_history = ?,
                     general_examination = ?, systematic_examination = ?, differential_diagnosis = ?, follow_up = ?,
                     disease = ?, diagnosis = ?, mental_mind_status = ?, formula_set_id = ?, formula_version_used = ?,
                     quick_formula_input = ?, universal_remark = ?, universal_remark_hi = ?,
                     workflow_status = ?, doctor_finalized_at = NOW(),
                     sent_to_medical_at = CASE WHEN ? = 1 THEN NOW() ELSE NULL END
                 WHERE id = ?`,
                [
                    req.user.id,
                    symptoms,
                    treatmentAdvice,
                    medicationDurationDays,
                    followUpChainClosed ? 1 : 0,
                    followUpAfterDays,
                    repeatedFromConsultationId,
                    isRepeat ? 1 : 0,
                    isSame ? 1 : 0,
                    repeatMonths || 0,
                    sameMonths || 0,
                    consultationMode,
                    oxygenSaturation,
                    bloodPressure,
                    patientHeight,
                    patientWeight,
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
                    diagnosis,
                    mentalMindStatus,
                    formulaSetId,
                    formulaVersionUsed,
                    quickFormulaInput,
                    universalRemark,
                    universalRemarkHi,
                    consultationWorkflowStatus,
                    shouldSendToMedical ? 1 : 0,
                    createdConsultationId,
                ]
            );

            await connection.execute(`DELETE FROM tbl_consultation_tests WHERE consultation_id = ?`, [createdConsultationId]);
            await connection.execute(`DELETE FROM tbl_consultation_medications WHERE consultation_id = ?`, [createdConsultationId]);

            const [oldPricing] = await connection.execute(
                `SELECT id FROM tbl_medical_prescription_pricing WHERE consultation_id = ? LIMIT 1`,
                [createdConsultationId]
            );
            if (oldPricing.length > 0) {
                await connection.execute(`DELETE FROM tbl_medical_prescription_pricing_items WHERE pricing_id = ?`, [oldPricing[0].id]);
                await connection.execute(`DELETE FROM tbl_medical_prescription_pricing WHERE id = ?`, [oldPricing[0].id]);
            }
        } else {
            const [consultationResult] = await connection.execute(
                `INSERT INTO tbl_consultations
                 (appointment_id, doctor_id, symptoms, treatment_advice, medication_duration_days,
                  follow_up_chain_closed, follow_up_after_days, repeated_from_consultation_id,
                  is_repeat, is_same, repeat_months, same_months, consultation_mode, oxygen_saturation, blood_pressure,
                  patient_height, patient_weight, occupation, history_present_illness, history_past_illness,
                  family_history, allergies_history, gynecological_history, personal_social_history,
                  general_examination, systematic_examination, differential_diagnosis, follow_up,
                  disease, diagnosis, mental_mind_status, formula_set_id, formula_version_used,
                  quick_formula_input, universal_remark, universal_remark_hi,
                  workflow_status, doctor_finalized_at, sent_to_medical_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), CASE WHEN ? = 1 THEN NOW() ELSE NULL END)`,
                [
                    appointmentId,
                    req.user.id,
                    symptoms,
                    treatmentAdvice,
                    medicationDurationDays,
                    followUpChainClosed ? 1 : 0,
                    followUpAfterDays,
                    repeatedFromConsultationId,
                    isRepeat ? 1 : 0,
                    isSame ? 1 : 0,
                    repeatMonths || 0,
                    sameMonths || 0,
                    consultationMode,
                    oxygenSaturation,
                    bloodPressure,
                    patientHeight,
                    patientWeight,
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
                    diagnosis,
                    mentalMindStatus,
                    formulaSetId,
                    formulaVersionUsed,
                    quickFormulaInput,
                    universalRemark,
                    universalRemarkHi,
                    consultationWorkflowStatus,
                    shouldSendToMedical ? 1 : 0,
                ]
            );
            createdConsultationId = consultationResult.insertId;
        }

        await saveUniversalRemarkSuggestion(connection, universalRemark);

        const pricingItems = [];

        for (const medication of medications) {
            if (medication.medicine_type === 'TEXT') {
                const displayParts = parseTextMedicineDisplayParts(medication.medicine_value);
                const masterMedicineValue = medication.master_medicine_value
                    || displayParts.medicine_value;
                const variantValue = medication.variant_value || displayParts.variant_value;
                const medicineTextId = await upsertMasterTextMedicine(
                    connection,
                    masterMedicineValue,
                    Boolean(medication.is_manual_entry)
                );

                if (medicineTextId && variantValue) {
                    const qty = medication.quantity || displayParts.quantity || 1;
                    const unitPrice = medication.variant_unit_price != null
                        ? medication.variant_unit_price
                        : (qty > 0 ? Number((Number(medication.amount || 0) / qty).toFixed(2)) : medication.amount);

                    await upsertDoctorManualVariant(
                        connection,
                        medicineTextId,
                        masterMedicineValue,
                        variantValue,
                        unitPrice
                    );
                }
            }

            await saveTextMedicineRemarkSuggestion(connection, medication);

            const [medicationResult] = await connection.execute(
                `INSERT INTO tbl_consultation_medications
                 (consultation_id, medicine_type, medicine_value, remark, remark_hi, is_manual_entry)
                 VALUES (?, ?, ?, ?, ?, ?)`,
                [
                    createdConsultationId,
                    medication.medicine_type,
                    medication.medicine_value,
                    medication.remark,
                    medication.remark_hi || null,
                    medication.is_manual_entry ? 1 : 0,
                ]
            );

            pricingItems.push({
                consultation_medication_id: medicationResult.insertId,
                medicine_value: medication.medicine_value,
                amount: medication.amount,
            });

            for (const dose of medication.doses) {
                await connection.execute(
                    `INSERT INTO tbl_medication_dosages
                     (consultation_medication_id, dose_label, sort_order, times_per_day, balls_per_dose, instructions)
                     VALUES (?, ?, ?, ?, ?, ?)`,
                    [medicationResult.insertId, dose.dose_label, dose.sort_order, dose.times_per_day, dose.balls_per_dose, dose.instructions]
                );
            }
        }

        for (const test of tests) {
            await connection.execute(
                `INSERT INTO tbl_consultation_tests
                 (consultation_id, test_name, amount)
                 VALUES (?, ?, ?)`,
                [createdConsultationId, test.test_name, test.amount]
            );
        }

        if (shouldSendToMedical) {
            const [pricingResult] = await connection.execute(
                `INSERT INTO tbl_medical_prescription_pricing
                 (consultation_id, total_amount, remark, created_by, updated_by)
                 VALUES (?, ?, ?, ?, ?)`,
                [createdConsultationId, totalAmount, 'Doctor entered initial pricing', req.user.id, req.user.id]
            );

            for (const item of pricingItems) {
                await connection.execute(
                    `INSERT INTO tbl_medical_prescription_pricing_items
                     (pricing_id, consultation_medication_id, medicine_value, amount)
                     VALUES (?, ?, ?, ?)`,
                    [pricingResult.insertId, item.consultation_medication_id, item.medicine_value, item.amount]
                );
            }
        }

        await connection.execute(
            `UPDATE tbl_appointments
             SET status = 'Completed',
                 updated_by = ?
             WHERE appointment_id = ?`,
            [req.user.id, appointmentId]
        );

        pendingFollowUp = await createNextFollowUpIfNeeded({
            connection,
            appointmentId,
            followUpAfterDays,
            followUpChainClosed,
        });

        if (!isLiveQueueCompletion) {
            await connection.execute(
                `UPDATE tbl_appointments
                 SET queue_status = ?,
                     actual_completed_at = COALESCE(actual_completed_at, NOW()),
                     last_queue_event_at = NOW(),
                     updated_by = ?
                 WHERE appointment_id = ?`,
                [QUEUE_STATUS.COMPLETED, req.user.id, appointmentId]
            );

            return {
                shouldAutoCallNext: false,
                isDirectConsultation: true,
                branchId: Number(appointment.fk_branch_id),
                slotId: null,
                appointmentDate: null,
            };
        }

        return markAppointmentQueueCompleted(connection, {
            appointmentId,
            actorUserId: req.user.id,
            eventType: 'CONSULTATION_COMPLETED',
        });
    });

    const consultation = await getConsultationAggregateByAppointmentId(appointmentId);
    const appointment = await getDoctorAppointmentById(appointmentId, req.selectedBranchId || null);

    if (shouldNotifyMedical) {
        await createNotificationsForRole({
            roleCode: 'MED',
            branchId: appointment?.fk_branch_id ? Number(appointment.fk_branch_id) : req.selectedBranchId || null,
            type: 'PRESCRIPTION_READY_FOR_MEDICAL',
            title: 'Prescription ready for medical',
            message: `Prescription for patient ${appointment?.patient_full_name || appointmentId} is ready for medical processing.`,
            entityType: 'consultation',
            entityId: createdConsultationId || consultation?.consultation_id || 0,
            emitEvent: 'prescription.ready_for_medical',
            emitPayload: {
                consultation_id: createdConsultationId || consultation?.consultation_id || null,
                appointment_id: appointmentId,
                patient_name: appointment?.patient_full_name || null,
                workflow_status: consultation?.workflow_status || 'READY_FOR_MEDICAL',
                message: 'Prescription ready for medical processing',
            },
        });
    }

    // Schedule automated WhatsApp follow-up reminders
    try {
        if (!followUpChainClosed && Number(followUpAfterDays) > 0) {
            await scheduleFollowUpReminders({
                consultationId: createdConsultationId || consultation?.consultation_id,
                appointmentId,
                doctorId: req.user.id,
                patientId: appointment?.fk_patient_id || consultation?.patient_id,
                branchId: appointment?.fk_branch_id || req.selectedBranchId || null,
                appointmentDate: appointment?.appointment_date,
                followUpAfterDays: Number(followUpAfterDays),
            });
        } else if (followUpChainClosed) {
            await cancelScheduledReminders({
                consultationId: createdConsultationId || consultation?.consultation_id,
                appointmentId,
                reason: 'FOLLOW_UP_CHAIN_CLOSED',
            });
        }
    } catch (waErr) {
        console.error('[WhatsApp Automation] Failed to schedule follow-up reminders:', waErr);
    }

    let autoCallNextDueAt = null;

    if (queueCompletionContext.shouldAutoCallNext) {
        autoCallNextDueAt = await scheduleAutoCallNext({
            branchId: queueCompletionContext.branchId,
            slotId: queueCompletionContext.slotId,
            appointmentDate: queueCompletionContext.appointmentDate,
            actorUserId: req.user.id,
            delayMs: DEFAULT_AUTO_CALL_DELAY_MS,
            reason: 'AUTO_CALL_NEXT_AFTER_CONSULT_COMPLETE',
        });
    }

    if (!queueCompletionContext.isDirectConsultation) {
        await emitLiveQueueEvent({
            branchId: queueCompletionContext.branchId,
            slotId: queueCompletionContext.slotId,
            appointmentDate: queueCompletionContext.appointmentDate,
            eventName: 'consultation-completed',
            reason: 'CONSULTATION_COMPLETED',
            appointmentId,
            extra: {
                auto_call_next_due_at: autoCallNextDueAt ? formatDateTimeForSql(autoCallNextDueAt) : null,
            },
        });
    }

    return res.status(201).json({
        success: true,
        message: updatedExistingConsultation
            ? 'Consultation updated successfully'
            : 'Consultation created successfully',
        data: {
            appointment,
            consultation,
            pending_follow_up: pendingFollowUp,
        },
    });
});

const getConsultationByAppointmentId = asyncHandler(async (req, res) => {
    const appointmentId = Number(req.params.appointment_id);

    if (!Number.isInteger(appointmentId) || appointmentId <= 0) {
        throw new AppError('Valid appointment_id is required', 400);
    }

    const appointment = await getDoctorAppointmentById(appointmentId, req.selectedBranchId || null);
    if (!appointment) {
        throw new AppError('Appointment not found', 404);
    }

    const consultation = await getConsultationAggregateByAppointmentId(appointmentId);
    if (!consultation) {
        throw new AppError('Consultation not found for this appointment', 404);
    }

    const pricing = await getMedicalPricingAggregateByConsultationId(consultation.consultation_id);
    const editAccess = await getConsultationEditAccess(query, consultation.consultation_id);
    const followUpChain = await enrichAppointmentChainWithConsultationData(
        await getAppointmentChain(appointmentId)
    );

    return res.status(200).json({
        success: true,
        message: 'Consultation fetched successfully',
        data: {
            appointment,
            consultation,
            pricing,
            edit_access: editAccess,
            follow_up_chain: followUpChain,
        },
    });
});

const getRepeatTreatmentDraft = asyncHandler(async (req, res) => {
    const appointmentId = Number(req.params.appointment_id);

    if (!Number.isInteger(appointmentId) || appointmentId <= 0) {
        throw new AppError('Valid appointment_id is required', 400);
    }

    const appointment = await getDoctorAppointmentById(appointmentId, req.selectedBranchId || null);
    if (!appointment) {
        throw new AppError('Appointment not found', 404);
    }

    const currentVisitType = getVisitTypeCode({
        treatmentId: appointment.fk_treatment_id,
        treatmentName: appointment.treatment_name,
        treatmentCode: appointment.treatment_code,
    });

    if (currentVisitType !== 'FOLLOW_UP_VISIT' || !appointment.parent_appointment_id) {
        throw new AppError('Repeat treatment is available only for follow-up visits', 409);
    }

    const sourceConsultation = await getConsultationAggregateByAppointmentId(appointment.parent_appointment_id);
    if (!sourceConsultation) {
        throw new AppError('Parent consultation not found', 404);
    }

    const pricing = await getMedicalPricingAggregateByConsultationId(sourceConsultation.consultation_id);
    const pricingByMedicationId = new Map(
        (pricing?.medications || []).map((item) => [
            Number(item.consultation_medication_id),
            Number(item.amount || 0),
        ])
    );

    return res.status(200).json({
        success: true,
        message: 'Repeat treatment draft fetched successfully',
        data: {
            source_consultation_id: sourceConsultation.consultation_id,
            source_appointment_id: sourceConsultation.appointment_id,
            medication_duration_days: sourceConsultation.medication_duration_days,
            universal_remark: sourceConsultation.universal_remark || null,
            universal_remark_hi: sourceConsultation.universal_remark_hi || null,
            medications: sourceConsultation.medications
                .filter((medication) => String(medication.added_by_role || 'DOCTOR').toUpperCase() !== 'MEDICAL')
                .map((medication) => ({
                    medicine_type: medication.medicine_type,
                    medicine_value: medication.medicine_value,
                    remark: medication.remark,
                    remark_hi: medication.remark_hi,
                    is_manual_entry: medication.is_manual_entry,
                    doses: medication.doses,
                    amount: pricingByMedicationId.get(Number(medication.consultation_medication_id)) || 0,
                })),
        },
    });
});

const normalizeSequenceNumber = (val) => {
    const parsed = Number(val);
    return Number.isInteger(parsed) && parsed >= 0 ? parsed : Number.MAX_SAFE_INTEGER;
};

const getPrescriptionSuggestions = asyncHandler(async (req, res) => {
    const appointmentId = Number(req.query.appointment_id);
    const symptoms = req.query.symptoms;
    const diagnosis = req.query.diagnosis;

    if (!Number.isInteger(appointmentId) || appointmentId <= 0) {
        throw new AppError('Valid appointment_id is required', 400);
    }

    const appointments = await query(
        `SELECT fk_patient_id FROM tbl_appointments WHERE appointment_id = ? LIMIT 1`,
        [appointmentId]
    );

    if (appointments.length === 0) {
        throw new AppError('Appointment not found', 404);
    }

    const patientId = Number(appointments[0].fk_patient_id);
    const trimmedSymptoms = String(symptoms || '').trim();
    const trimmedDiagnosis = String(diagnosis || '').trim();

    if (!trimmedSymptoms && !trimmedDiagnosis) {
        return res.status(200).json({
            success: true,
            message: 'No symptoms or diagnosis provided for suggestions',
            data: [],
        });
    }

    // CASE 1: Search patient's own history
    let patientMatchRows = [];
    const patientMatchConditions = [];
    const patientMatchParams = [patientId];

    if (trimmedSymptoms) {
        patientMatchConditions.push(`LOWER(c.symptoms) LIKE ? OR LOWER(c.disease) LIKE ?`);
        patientMatchParams.push(`%${trimmedSymptoms.toLowerCase()}%`, `%${trimmedSymptoms.toLowerCase()}%`);
    }
    if (trimmedDiagnosis) {
        patientMatchConditions.push(`LOWER(c.diagnosis) LIKE ? OR LOWER(c.disease) LIKE ?`);
        patientMatchParams.push(`%${trimmedDiagnosis.toLowerCase()}%`, `%${trimmedDiagnosis.toLowerCase()}%`);
    }

    let sqlPatient = `
        SELECT DISTINCT c.quick_formula_input
        FROM tbl_consultations c
        JOIN tbl_appointments a ON a.appointment_id = c.appointment_id
        WHERE a.fk_patient_id = ? 
          AND a.is_active = 1 
          AND c.quick_formula_input IS NOT NULL 
          AND TRIM(c.quick_formula_input) <> ''
    `;

    if (patientMatchConditions.length > 0) {
        sqlPatient += ` AND (${patientMatchConditions.join(' OR ')}) ORDER BY c.created_at DESC LIMIT 50`;
        patientMatchRows = await query(sqlPatient, patientMatchParams);
    }

    let targetRows = [];
    let isPatientHistoryUsed = false;

    if (patientMatchRows.length > 0) {
        targetRows = patientMatchRows;
        isPatientHistoryUsed = true;
    } else {
        // CASE 2: Global history search
        let globalMatchRows = [];
        const globalMatchConditions = [];
        const globalMatchParams = [];

        if (trimmedSymptoms) {
            globalMatchConditions.push(`LOWER(c.symptoms) LIKE ? OR LOWER(c.disease) LIKE ?`);
            globalMatchParams.push(`%${trimmedSymptoms.toLowerCase()}%`, `%${trimmedSymptoms.toLowerCase()}%`);
        }
        if (trimmedDiagnosis) {
            globalMatchConditions.push(`LOWER(c.diagnosis) LIKE ? OR LOWER(c.disease) LIKE ?`);
            globalMatchParams.push(`%${trimmedDiagnosis.toLowerCase()}%`, `%${trimmedDiagnosis.toLowerCase()}%`);
        }

        let sqlGlobal = `
            SELECT DISTINCT c.quick_formula_input
            FROM tbl_consultations c
            JOIN tbl_appointments a ON a.appointment_id = c.appointment_id
            WHERE a.is_active = 1 
              AND c.quick_formula_input IS NOT NULL 
              AND TRIM(c.quick_formula_input) <> ''
        `;

        if (globalMatchConditions.length > 0) {
            sqlGlobal += ` AND (${globalMatchConditions.join(' OR ')}) ORDER BY c.created_at DESC LIMIT 50`;
            globalMatchRows = await query(sqlGlobal, globalMatchParams);
        }
        targetRows = globalMatchRows;
    }

    const uniqueSuggestions = Array.from(
        new Set(
            targetRows
                .map((r) => String(r.quick_formula_input || '').trim())
                .filter(Boolean)
        )
    );

    return res.status(200).json({
        success: true,
        message: 'Prescription suggestions fetched successfully',
        basis: isPatientHistoryUsed ? 'PATIENT_HISTORY' : 'GLOBAL_HISTORY',
        data: uniqueSuggestions,
    });
});

module.exports = {
    createConsultation,
    getConsultationEditAccess,
    getConsultationByAppointmentId,
    getRepeatTreatmentDraft,
    getPrescriptionSuggestions,
};
