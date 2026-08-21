const { query, withTransaction } = require('../../config/db');
const { randomUUID } = require('crypto');
const AppError = require('../../utils/AppError');
const asyncHandler = require('../../utils/asyncHandler');
const { createNotificationsForRole, createNotificationForUser } = require('../../utils/notificationService');
const {
    createMedicationBillFromConsultation,
    createRepeatMedicineBill,
    collectMedicationBillPayment,
    getBillDetailById,
} = require('../../services/billingService');
const { decorateTokenFields } = require('../../utils/tokenDisplay');
const { getAppointmentPatientColumns, getAppointmentPatientJoin } = require('../../utils/patientFamily');
const {
    createMedicalProductTemplateWorkbook,
    importMedicalProductsFromWorkbook,
} = require('../../services/medicalProductImportService');
const {
    listMedicalProducts,
    getMedicalProductById,
    createMedicalProduct,
    updateMedicalProduct,
    deleteMedicalProduct,
    getMedicalProductSummary,
} = require('../../services/medicalProductMasterService');
const {
    calculateDispensingTotal,
    ensureDispensingMutationAllowed,
    projectDispensingStatus,
    resolveDispensingEventType,
    validatePrescribedDispensingItems,
} = require('../../services/dispensaryPricingService');

const { parsePagination, resolvePagination, buildPaginationMeta } = require('../../utils/pagination');

const toPositiveInt = (value) => {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) {
        return null;
    }

    return parsed;
};

const toPositiveAmount = (value) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) {
        return null;
    }

    return Number(parsed.toFixed(2));
};

const toBoolean = (value) => value === true || String(value).trim().toLowerCase() === 'true';

const normalizeMedicalPaymentPayload = (value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return null;
    }

    const hasAnyPaymentField = ['payment_mode', 'amount', 'transaction_reference', 'remark']
        .some((field) => value[field] !== undefined && value[field] !== null && String(value[field]).trim() !== '');

    if (!hasAnyPaymentField) {
        return null;
    }

    const paymentMode = value.payment_mode ? String(value.payment_mode).trim().toUpperCase() : '';
    const amount = toPositiveAmount(value.amount);
    const transactionReference = value.transaction_reference ? String(value.transaction_reference).trim() : null;
    const remark = value.remark ? String(value.remark).trim() : null;

    if (!paymentMode) {
        throw new AppError('payment.payment_mode is required', 400);
    }

    if (amount === null || amount <= 0) {
        throw new AppError('payment.amount must be a valid number greater than 0', 400);
    }

    return {
        payment_mode: paymentMode,
        amount,
        transaction_reference: transactionReference,
        remark,
    };
};

const notifyMedicalPrescriptionProcessed = async ({ consultationId, detail }) => {
    await createNotificationsForRole({
        roleCode: 'REC',
        branchId: detail?.fk_branch_id ? Number(detail.fk_branch_id) : null,
        type: 'PRESCRIPTION_PROCESSED_BY_MEDICAL',
        title: 'Prescription processed',
        message: `Medical processed prescription for patient ${detail?.patient_full_name || consultationId}.`,
        entityType: 'consultation',
        entityId: consultationId,
        emitEvent: 'prescription.processed',
        emitPayload: {
            consultation_id: consultationId,
            appointment_id: detail?.appointment_id || null,
            workflow_status: detail?.workflow_status || 'PROCESSED_BY_MEDICAL',
        },
    });

    if (detail?.doctor_id) {
        await createNotificationForUser({
            userId: detail.doctor_id,
            branchId: detail?.fk_branch_id ? Number(detail.fk_branch_id) : null,
            roleCode: 'DOC',
            type: 'PRESCRIPTION_PROCESSED_BY_MEDICAL',
            title: 'Prescription processed by medical',
            message: `Medical processed prescription for patient ${detail?.patient_full_name || consultationId}.`,
            entityType: 'consultation',
            entityId: consultationId,
            emitEvent: 'prescription.processed',
            emitPayload: {
                consultation_id: consultationId,
                appointment_id: detail?.appointment_id || null,
                workflow_status: detail?.workflow_status || 'PROCESSED_BY_MEDICAL',
            },
        });
    }
};

const finalizeMedicalPrescription = async ({
    connection,
    consultationId,
    medicalUserId,
    payment = null,
}) => {
    const [rows] = await connection.execute(
        `SELECT id, doctor_id, workflow_status
         FROM tbl_consultations
         WHERE id = ?
         LIMIT 1
         FOR UPDATE`,
        [consultationId]
    );

    if (rows.length === 0) {
        throw new AppError('Prescription not found', 404);
    }

    if (rows[0].workflow_status !== 'READY_FOR_MEDICAL') {
        throw new AppError('Only medical-ready prescriptions can be processed', 409);
    }

    const billResult = await createMedicationBillFromConsultation({
        connection,
        consultationId,
        createdByUserId: medicalUserId,
    });

    let paymentResult = null;

    if (payment) {
        paymentResult = await collectMedicationBillPayment({
            connection,
            billId: billResult.billId,
            consultationId,
            amount: payment.amount,
            paymentMode: payment.payment_mode,
            transactionReference: payment.transaction_reference,
            remark: payment.remark,
            collectedByUserId: medicalUserId,
            collectedByRole: 'MED',
        });
    }

    await connection.execute(
        `UPDATE tbl_consultations
         SET workflow_status = 'PROCESSED_BY_MEDICAL',
             medical_processed_at = NOW(),
             medical_processed_by = ?
         WHERE id = ?`,
        [medicalUserId, consultationId]
    );

    return {
        doctorId: rows[0].doctor_id,
        billId: billResult.billId,
        billCreated: billResult.created,
        paymentStatus: paymentResult?.paymentStatus || null,
    };
};

const getMedicalPricingByConsultationId = async (consultationId) => {
    const pricingRows = await query(
        `SELECT id AS pricing_id, consultation_id, total_amount, remark, created_by, updated_by, created_at, updated_at
         FROM tbl_medical_prescription_pricing
         WHERE consultation_id = ?
         LIMIT 1`,
        [consultationId]
    );

    if (pricingRows.length === 0) {
        return null;
    }

    const items = await query(
        `SELECT
            id AS pricing_item_id,
            consultation_medication_id,
            medicine_value,
            amount,
            dispense_status,
            void_reason,
            voided_by,
            voided_at,
            version,
            created_at,
            updated_at
         FROM tbl_medical_prescription_pricing_items
         WHERE pricing_id = ?
         ORDER BY id ASC`,
        [pricingRows[0].pricing_id]
    );

    const events = await query(
        `SELECT
            e.id AS event_id,
            e.pricing_item_id,
            e.consultation_medication_id,
            e.event_type,
            e.old_amount,
            e.new_amount,
            e.old_status,
            e.new_status,
            e.reason,
            e.actor_user_id,
            e.actor_role,
            u.full_name AS actor_name,
            e.created_at
         FROM tbl_medical_dispensing_item_events e
         LEFT JOIN master_users u ON u.id = e.actor_user_id
         WHERE e.consultation_id = ?
         ORDER BY e.id ASC`,
        [consultationId]
    );

    const eventsByMedicationId = new Map();
    events.forEach((event) => {
        const medicationId = Number(event.consultation_medication_id);
        if (!eventsByMedicationId.has(medicationId)) {
            eventsByMedicationId.set(medicationId, []);
        }
        eventsByMedicationId.get(medicationId).push(event);
    });

    return {
        ...pricingRows[0],
        medications: items.map((item) => ({
            ...item,
            dispense_status: item.dispense_status || 'ACTIVE',
            events: eventsByMedicationId.get(Number(item.consultation_medication_id)) || [],
        })),
    };
};

const buildMedicalPrescriptionListItemResponse = (row, detail) => {
    const pricing = detail?.pricing || null;

    return {
        consultation_id: row.consultation_id,
        appointment_id: row.appointment_id,
        workflow_status: row.workflow_status,
        sent_to_medical_at: row.sent_to_medical_at,
        pricing_status: pricing ? 'PRICED' : 'UNPRICED',
        is_priced: Boolean(pricing),
        appointment: {
            appointment_id: row.appointment_id,
            auid: row.auid,
            appointment_date: row.appointment_date,
            ...decorateTokenFields({
                slot_name: row.slot_name,
                start_time: row.start_time,
                token_number: row.token_number,
                original_token_number: row.original_token_number,
                current_token_number: row.current_token_number,
            }),
            status: row.appointment_status,
            branch_name: row.branch_name,
            treatment_name: row.treatment_name,
            slot_name: row.slot_name,
            start_time: row.start_time,
            end_time: row.end_time,
        },
        patient: {
            patient_uuid: row.patient_uuid,
            full_name: row.patient_full_name,
            mobile_no: row.patient_mobile_no,
            email: row.patient_email,
            age: row.patient_age,
            gender: row.patient_gender,
            description: row.patient_description,
            booked_for_type: row.booked_for_type,
            family_member_relationship: row.family_member_relationship,
            primary_patient_full_name: row.primary_patient_full_name,
            is_family_member_booking: Boolean(row.is_family_member_booking),
        },
        doctor: {
            doctor_id: row.doctor_id,
            doctor_name: row.doctor_name,
        },
        prescription: {
            medication_duration_days: row.medication_duration_days,
            quick_formula_input: detail?.quick_formula_input ?? null,
            universal_remark: detail?.universal_remark ?? null,
            universal_remark_hi: detail?.universal_remark_hi ?? null,
            symptoms: row.symptoms,
            treatment_advice: row.treatment_advice,
            created_at: row.created_at,
            updated_at: row.updated_at,
            medications: detail?.medications || [],
            tests: detail?.tests || [],
            pricing,
        },
    };
};

const buildMedicalPrescriptionListItem = async (row) => {
    const detail = await getMedicalPrescriptionDetail(row.consultation_id, row.fk_branch_id || null);
    return buildMedicalPrescriptionListItemResponse(row, detail);
};

const getMedicalPrescriptionDetail = async (consultationId, branchId = null) => {
    const params = [consultationId];
    const branchCondition = branchId ? ' AND a.fk_branch_id = ?' : '';

    if (branchId) {
        params.push(branchId);
    }

    const rows = await query(
        `SELECT
            c.id AS consultation_id,
            c.appointment_id,
            a.fk_branch_id,
            c.doctor_id,
            c.workflow_status,
            c.medication_duration_days,
            c.quick_formula_input,
            c.universal_remark,
            c.universal_remark_hi,
            c.symptoms,
            c.treatment_advice,
            c.created_at,
            c.updated_at,
            c.sent_to_medical_at,
            c.medical_processed_at,
            a.appointment_date,
            ${getAppointmentPatientColumns()},
            d.full_name AS doctor_name,
            b.branch_name,
            t.treatment_name
         FROM tbl_consultations c
         JOIN tbl_appointments a ON a.appointment_id = c.appointment_id
         ${getAppointmentPatientJoin()}
         JOIN master_users d ON d.id = c.doctor_id
         JOIN master_clinic_branches b ON b.id = a.fk_branch_id
         JOIN master_treatments t ON t.id = a.fk_treatment_id
         WHERE c.id = ?
         ${branchCondition}
         LIMIT 1`,
        params
    );

    if (rows.length === 0) {
        return null;
    }

    const medications = await query(
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
         LEFT JOIN tbl_medication_dosages md ON md.consultation_medication_id = cm.id
         WHERE cm.consultation_id = ?
         ORDER BY cm.id ASC, COALESCE(md.sort_order, 999) ASC, md.id ASC`,
        [consultationId]
    );

    const medicationMap = new Map();

    medications.forEach((row) => {
        if (!medicationMap.has(row.consultation_medication_id)) {
            medicationMap.set(row.consultation_medication_id, {
                consultation_medication_id: row.consultation_medication_id,
                medicine_type: row.medicine_type,
                medicine_value: row.medicine_value,
                remark: row.remark,
                added_by_role: row.added_by_role || 'DOCTOR',
                doses: [],
            });
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

    const pricing = await getMedicalPricingByConsultationId(consultationId);
    const pricingByMedicationId = new Map(
        (pricing?.medications || []).map((item) => [Number(item.consultation_medication_id), item])
    );

    return {
        ...rows[0],
        medications: Array.from(medicationMap.values()).map((medication) => projectDispensingStatus(
            medication,
            pricingByMedicationId.get(Number(medication.consultation_medication_id)) || null
        )),
        tests: testRows,
        pricing,
    };
};

const listRepeatMedicinePatients = asyncHandler(async (req, res) => {
    const search = req.query.search ? String(req.query.search).trim() : '';

    if (search.length < 2) {
        throw new AppError('Search at least 2 characters to find a patient', 400);
    }

    const rows = await query(
        `SELECT
            id AS patient_id,
            uuid,
            full_name,
            mobile_no,
            age,
            gender
         FROM master_users
         WHERE is_active = 1
           AND role = 'PAT'
           AND (
                full_name LIKE ?
             OR mobile_no LIKE ?
             OR uuid LIKE ?
           )
         ORDER BY full_name ASC
         LIMIT 20`,
        [`%${search}%`, `%${search}%`, `%${search}%`]
    );

    return res.status(200).json({
        success: true,
        message: 'Patients fetched successfully',
        data: rows,
    });
});

const getRepeatMedicineLastPrescription = asyncHandler(async (req, res) => {
    const patientId = toPositiveInt(req.params.patient_id);
    const branchId = req.selectedBranchId || toPositiveInt(req.query.branch_id);

    if (!patientId) {
        throw new AppError('Valid patient_id is required', 400);
    }

    if (!branchId) {
        throw new AppError('Branch is required for repeat medicine', 400);
    }

    const patientRows = await query(
        `SELECT id AS patient_id, uuid, full_name, mobile_no, age, gender
         FROM master_users
         WHERE id = ?
           AND is_active = 1
           AND role = 'PAT'
         LIMIT 1`,
        [patientId]
    );

    if (patientRows.length === 0) {
        throw new AppError('Patient not found', 404);
    }

    const consultationRows = await query(
        `SELECT
            c.id AS consultation_id,
            c.appointment_id,
            c.doctor_id,
            d.full_name AS doctor_name,
            c.medication_duration_days,
            c.symptoms,
            c.treatment_advice,
            c.workflow_status,
            COALESCE(c.doctor_finalized_at, c.created_at) AS prescription_date,
            a.appointment_date,
            a.auid,
            a.current_token_number AS token_number,
            b.branch_name,
            t.treatment_name
         FROM tbl_consultations c
         JOIN tbl_appointments a ON a.appointment_id = c.appointment_id
         JOIN master_users d ON d.id = c.doctor_id
         JOIN master_clinic_branches b ON b.id = a.fk_branch_id
         JOIN master_treatments t ON t.id = a.fk_treatment_id
         WHERE a.fk_patient_id = ?
           AND a.fk_branch_id = ?
           AND EXISTS (
                SELECT 1
                FROM tbl_consultation_medications cm
                WHERE cm.consultation_id = c.id
                  AND COALESCE(cm.added_by_role, 'DOCTOR') = 'DOCTOR'
           )
         ORDER BY COALESCE(c.doctor_finalized_at, c.created_at) DESC, c.id DESC
         LIMIT 1`,
        [patientId, branchId]
    );

    if (consultationRows.length === 0) {
        throw new AppError('No previous doctor prescription found for this patient in selected branch', 404);
    }

    const consultation = consultationRows[0];
    const medicationRows = await query(
        `SELECT
            cm.id AS consultation_medication_id,
            cm.medicine_type,
            cm.medicine_value,
            cm.remark,
            mppi.amount AS last_amount
         FROM tbl_consultation_medications cm
         LEFT JOIN tbl_medical_prescription_pricing mpp
           ON mpp.consultation_id = cm.consultation_id
         LEFT JOIN tbl_medical_prescription_pricing_items mppi
           ON mppi.pricing_id = mpp.id
          AND mppi.consultation_medication_id = cm.id
          AND mppi.dispense_status = 'ACTIVE'
         WHERE cm.consultation_id = ?
           AND COALESCE(cm.added_by_role, 'DOCTOR') = 'DOCTOR'
         ORDER BY cm.id ASC`,
        [consultation.consultation_id]
    );

    return res.status(200).json({
        success: true,
        message: 'Last prescription fetched successfully',
        data: {
            patient: patientRows[0],
            prescription: decorateTokenFields({
                ...consultation,
                medications: medicationRows.map((row) => ({
                    ...row,
                    last_amount: row.last_amount || 0,
                })),
            }),
        },
    });
});

const createRepeatMedicineBillController = asyncHandler(async (req, res) => {
    const patientId = toPositiveInt(req.body?.patient_id);
    const sourceConsultationId = toPositiveInt(req.body?.source_consultation_id);
    const branchId = req.selectedBranchId || toPositiveInt(req.body?.branch_id);
    const submittedMedicines = Array.isArray(req.body?.medicines) ? req.body.medicines : [];
    const submittedAdditional = Array.isArray(req.body?.additional_medications) ? req.body.additional_medications : [];
    const remark = req.body?.remark ? String(req.body.remark).trim() : null;
    const payment = normalizeMedicalPaymentPayload(req.body?.payment);
    const delivery = req.body?.delivery && typeof req.body.delivery === 'object' && !Array.isArray(req.body.delivery)
        ? req.body.delivery
        : {};
    const deliveryMode = String(delivery.delivery_mode || 'HAND_DELIVERY').trim().toUpperCase() === 'COURIER'
        ? 'COURIER'
        : 'HAND_DELIVERY';
    const courierCharge = toPositiveAmount(delivery.courier_charge || 0);
    const deliveryDetails = {
        received_by: delivery.received_by ? String(delivery.received_by).trim() : null,
        courier_address: delivery.courier_address ? String(delivery.courier_address).trim() : null,
        tracking_no: delivery.tracking_no ? String(delivery.tracking_no).trim() : null,
        delivery_remark: delivery.delivery_remark ? String(delivery.delivery_remark).trim() : null,
    };

    if (!patientId) {
        throw new AppError('Valid patient_id is required', 400);
    }

    if (!sourceConsultationId) {
        throw new AppError('Valid source_consultation_id is required', 400);
    }

    if (!branchId) {
        throw new AppError('Branch is required for repeat medicine', 400);
    }

    if (submittedMedicines.length === 0 && submittedAdditional.length === 0) {
        throw new AppError('Select at least one prescribed medicine or add a medical medicine', 400);
    }

    if (courierCharge === null) {
        throw new AppError('delivery.courier_charge must be a valid non-negative number', 400);
    }

    if (deliveryMode === 'COURIER' && !deliveryDetails.courier_address) {
        throw new AppError('Courier address is required for courier delivery', 400);
    }

    const normalizedAdditionalItems = submittedAdditional.map((item, index) => {
        const medicineValue = String(item?.medicine_value || '').trim();
        const reason = String(item?.reason || '').trim();
        const amount = toPositiveAmount(item?.amount);

        if (!medicineValue) {
            throw new AppError(`additional_medications[${index}].medicine_value is required`, 400);
        }

        if (!reason) {
            throw new AppError(`additional_medications[${index}].reason is required`, 400);
        }

        if (amount === null || amount <= 0) {
            throw new AppError(`additional_medications[${index}].amount must be greater than 0`, 400);
        }

        return {
            medicine_value: medicineValue,
            reason,
            amount,
        };
    });

    let billId = null;

    await withTransaction(async (connection) => {
        const [consultationRows] = await connection.execute(
            `SELECT c.id, a.fk_patient_id, a.fk_branch_id
             FROM tbl_consultations c
             JOIN tbl_appointments a ON a.appointment_id = c.appointment_id
             WHERE c.id = ?
             LIMIT 1
             FOR UPDATE`,
            [sourceConsultationId]
        );

        if (consultationRows.length === 0) {
            throw new AppError('Source prescription not found', 404);
        }

        if (Number(consultationRows[0].fk_patient_id) !== Number(patientId)) {
            throw new AppError('Source prescription does not belong to selected patient', 400);
        }

        if (Number(consultationRows[0].fk_branch_id) !== Number(branchId)) {
            throw new AppError('Repeat medicine is allowed only for selected branch prescription', 403);
        }

        const requestedMedicineIds = submittedMedicines
            .map((item) => toPositiveInt(item?.consultation_medication_id))
            .filter(Boolean);

        const prescribedItems = [];
        if (requestedMedicineIds.length > 0) {
            const [medicineRows] = await connection.execute(
                `SELECT id AS consultation_medication_id, medicine_value
                 FROM tbl_consultation_medications
                 WHERE consultation_id = ?
                   AND COALESCE(added_by_role, 'DOCTOR') = 'DOCTOR'
                   AND id IN (${requestedMedicineIds.map(() => '?').join(',')})
                 FOR UPDATE`,
                [sourceConsultationId, ...requestedMedicineIds]
            );

            if (medicineRows.length !== requestedMedicineIds.length) {
                throw new AppError('One or more medicines are not part of the selected doctor prescription', 400);
            }

            const medicineMap = new Map(medicineRows.map((row) => [Number(row.consultation_medication_id), row]));
            for (const item of submittedMedicines) {
                const medicationId = toPositiveInt(item?.consultation_medication_id);
                if (!medicationId) continue;
                const amount = toPositiveAmount(item?.amount);
                if (amount === null || amount <= 0) {
                    throw new AppError('Selected medicine amount must be greater than 0', 400);
                }
                const medicine = medicineMap.get(medicationId);
                prescribedItems.push({
                    consultation_medication_id: medicationId,
                    medicine_value: medicine.medicine_value,
                    amount,
                });
            }
        }

        const billResult = await createRepeatMedicineBill({
            connection,
            patientId,
            branchId,
            sourceConsultationId,
            prescribedItems,
            additionalItems: normalizedAdditionalItems,
            courierCharge: deliveryMode === 'COURIER' ? courierCharge : 0,
            deliveryMode,
            deliveryDetails: {
                mode: deliveryMode,
                ...deliveryDetails,
                courier_charge: deliveryMode === 'COURIER' ? courierCharge : 0,
            },
            createdByUserId: req.user.id,
            remark,
        });

        billId = billResult.billId;

        if (payment) {
            await collectMedicationBillPayment({
                connection,
                billId,
                consultationId: sourceConsultationId,
                amount: payment.amount,
                paymentMode: payment.payment_mode,
                transactionReference: payment.transaction_reference,
                remark: payment.remark,
                collectedByUserId: req.user.id,
                collectedByRole: req.user.role_code,
            });
        }
    });

    const bill = await getBillDetailById(billId);

    return res.status(201).json({
        success: true,
        message: 'Repeat medicine bill created successfully',
        data: bill,
    });
});

const listMedicalPrescriptions = asyncHandler(async (req, res) => {
    const branchId = req.query.branch_id !== undefined ? toPositiveInt(req.query.branch_id) : null;
    const pricingStatus = String(req.query.pricing_status || 'all').trim().toLowerCase();
    const appointmentDate = req.query.appointment_date ? String(req.query.appointment_date).trim() : null;
    const appointmentStatusRaw = req.query.status ? String(req.query.status).trim().toLowerCase() : null;
    const appointmentStatus =
        appointmentStatusRaw === 'pending' ? 'Pending'
            : appointmentStatusRaw === 'completed' ? 'Completed'
                : appointmentStatusRaw === 'confirmed' ? 'Confirmed'
                    : appointmentStatusRaw === 'cancelled' ? 'Cancelled'
                        : appointmentStatusRaw === 'all' ? null
                            : appointmentStatusRaw;
    const patientSearch = req.query.patient_search ? String(req.query.patient_search).trim() : null;

    if (!['all', 'priced', 'unpriced'].includes(pricingStatus)) {
        throw new AppError('pricing_status must be one of all, priced or unpriced', 400);
    }

    if (req.query.branch_id !== undefined && !branchId) {
        throw new AppError('branch_id must be a positive integer', 400);
    }

    if (appointmentDate && !/^\d{4}-\d{2}-\d{2}$/.test(appointmentDate)) {
        throw new AppError('appointment_date must be in YYYY-MM-DD format', 400);
    }

    if (appointmentStatus && !['Pending', 'Completed', 'Confirmed', 'Cancelled'].includes(appointmentStatus)) {
        throw new AppError('status must be one of Pending, Completed, Confirmed or Cancelled', 400);
    }

    const pricingJoin =
        pricingStatus === 'priced'
            ? 'JOIN tbl_medical_prescription_pricing mpp ON mpp.consultation_id = c.id'
            : pricingStatus === 'unpriced'
                ? 'LEFT JOIN tbl_medical_prescription_pricing mpp ON mpp.consultation_id = c.id'
                : 'LEFT JOIN tbl_medical_prescription_pricing mpp ON mpp.consultation_id = c.id';

    const conditions = [`c.workflow_status = 'READY_FOR_MEDICAL'`];
    const params = [];

    if (pricingStatus === 'unpriced') {
        conditions.push('mpp.id IS NULL');
    }

    if (appointmentDate) {
        conditions.push('a.appointment_date = ?');
        params.push(appointmentDate);
    }

    if (appointmentStatus) {
        conditions.push('a.status = ?');
        params.push(appointmentStatus);
    }

    if (branchId) {
        conditions.push('a.fk_branch_id = ?');
        params.push(branchId);
    }

    if (patientSearch) {
        conditions.push('(COALESCE(fm.full_name, p.full_name) LIKE ? OR p.full_name LIKE ? OR p.mobile_no LIKE ? OR p.uuid LIKE ? OR a.auid LIKE ?)');
        params.push(`%${patientSearch}%`, `%${patientSearch}%`, `%${patientSearch}%`, `%${patientSearch}%`, `%${patientSearch}%`);
    }

    const { page, pageSize } = parsePagination(req.query);
    const whereClause = `WHERE ${conditions.join(' AND ')}`;
    const fromSql = `FROM tbl_consultations c
         JOIN tbl_appointments a ON a.appointment_id = c.appointment_id
         ${getAppointmentPatientJoin()}
         JOIN master_users d ON d.id = c.doctor_id
         JOIN master_clinic_branches b ON b.id = a.fk_branch_id
         JOIN master_treatments t ON t.id = a.fk_treatment_id
         JOIN master_slots s ON s.id = a.fk_slot_id
         LEFT JOIN tbl_doctor_slot_time_overrides sto
           ON sto.fk_branch_id = a.fk_branch_id
          AND sto.fk_slot_id = a.fk_slot_id
          AND sto.appointment_date = a.appointment_date
          AND sto.status = 'ACTIVE'
         ${pricingJoin}
         ${whereClause}`;

    const [countRows, rows] = await Promise.all([
        query(`SELECT COUNT(*) AS total ${fromSql}`, params),
        query(
            `SELECT
            c.id AS consultation_id,
            c.appointment_id,
            c.workflow_status,
            c.sent_to_medical_at,
            c.medication_duration_days,
            c.symptoms,
            c.treatment_advice,
            c.created_at,
            c.updated_at,
            a.auid,
            ${getAppointmentPatientColumns()},
            d.full_name AS doctor_name,
            d.id AS doctor_id,
            a.appointment_date,
            a.current_token_number AS token_number,
            a.original_token_number,
            a.current_token_number,
            a.status AS appointment_status,
            b.branch_name,
            t.treatment_name,
            s.slot_name,
            COALESCE(sto.override_start_time, s.start_time) AS start_time,
            COALESCE(sto.override_end_time, s.end_time) AS end_time
         ${fromSql}
         ORDER BY c.sent_to_medical_at DESC, c.id DESC
         LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
            params
        ),
    ]);

    const pagination = resolvePagination({
        page,
        pageSize,
        total: Number(countRows[0]?.total || 0),
    });

    const data = await Promise.all(rows.map(buildMedicalPrescriptionListItem));

    return res.status(200).json({
        success: true,
        message: 'Medical prescriptions fetched successfully',
        data,
        meta: {
            ...buildPaginationMeta(pagination),
            total: pagination.total,
            filters: {
                pricing_status: pricingStatus,
                branch_id: branchId,
                appointment_date: appointmentDate,
                status: appointmentStatus,
                patient_search: patientSearch,
            },
        },
    });
});

const listPricedMedicalPrescriptions = asyncHandler(async (req, res) => {
    const branchId = req.query.branch_id !== undefined ? toPositiveInt(req.query.branch_id) : null;
    const appointmentDate = req.query.appointment_date ? String(req.query.appointment_date).trim() : null;
    const patientSearch = req.query.patient_search ? String(req.query.patient_search).trim() : null;
    const page = toPositiveInt(req.query.page) || 1;
    const requestedPageSize = toPositiveInt(req.query.page_size) || 20;
    const pageSize = Math.min(requestedPageSize, 100);
    const offset = (page - 1) * pageSize;

    if (req.query.branch_id !== undefined && !branchId) {
        throw new AppError('branch_id must be a positive integer', 400);
    }

    if (appointmentDate && !/^\d{4}-\d{2}-\d{2}$/.test(appointmentDate)) {
        throw new AppError('appointment_date must be in YYYY-MM-DD format', 400);
    }

    const conditions = [`c.workflow_status IN ('READY_FOR_MEDICAL', 'PROCESSED_BY_MEDICAL')`];
    const params = [];
    const repeatConditions = [
        `b.status = 'ACTIVE'`,
        `b.bill_type = 'MEDICATION'`,
        `b.appointment_id IS NULL`,
        `b.remark LIKE 'Repeat Medicine%'`,
    ];
    const repeatParams = [];

    if (branchId) {
        conditions.push('a.fk_branch_id = ?');
        params.push(branchId);
        repeatConditions.push('b.fk_branch_id = ?');
        repeatParams.push(branchId);
    }

    if (appointmentDate) {
        conditions.push('a.appointment_date = ?');
        params.push(appointmentDate);
        repeatConditions.push('DATE(b.created_at) = ?');
        repeatParams.push(appointmentDate);
    }

    if (patientSearch) {
        conditions.push('(COALESCE(fm.full_name, p.full_name) LIKE ? OR p.full_name LIKE ? OR p.mobile_no LIKE ? OR p.uuid LIKE ? OR a.auid LIKE ?)');
        params.push(`%${patientSearch}%`, `%${patientSearch}%`, `%${patientSearch}%`, `%${patientSearch}%`, `%${patientSearch}%`);
        repeatConditions.push('(p.full_name LIKE ? OR p.mobile_no LIKE ? OR p.uuid LIKE ? OR b.bill_number LIKE ?)');
        repeatParams.push(`%${patientSearch}%`, `%${patientSearch}%`, `%${patientSearch}%`, `%${patientSearch}%`);
    }

    const whereClause = `WHERE ${conditions.join(' AND ')}`;
    const repeatWhereClause = `WHERE ${repeatConditions.join(' AND ')}`;

    const [countRows, rows, repeatCountRows, repeatRows] = await Promise.all([
        query(
            `SELECT COUNT(*) AS total
             FROM tbl_consultations c
             JOIN tbl_appointments a ON a.appointment_id = c.appointment_id
             ${getAppointmentPatientJoin()}
             JOIN master_users d ON d.id = c.doctor_id
             JOIN master_clinic_branches b ON b.id = a.fk_branch_id
             JOIN master_treatments t ON t.id = a.fk_treatment_id
             JOIN master_slots s ON s.id = a.fk_slot_id
             LEFT JOIN tbl_doctor_slot_time_overrides sto
               ON sto.fk_branch_id = a.fk_branch_id
              AND sto.fk_slot_id = a.fk_slot_id
              AND sto.appointment_date = a.appointment_date
              AND sto.status = 'ACTIVE'
             JOIN tbl_medical_prescription_pricing mpp ON mpp.consultation_id = c.id
             ${whereClause}`,
            params
        ),
        query(
            `SELECT
                c.id AS consultation_id,
                c.appointment_id,
                a.fk_branch_id,
                c.workflow_status,
                c.sent_to_medical_at,
                c.medication_duration_days,
                c.symptoms,
                c.treatment_advice,
                c.created_at,
                c.updated_at,
                a.auid,
                ${getAppointmentPatientColumns()},
                d.full_name AS doctor_name,
                d.id AS doctor_id,
                a.appointment_date,
                a.current_token_number AS token_number,
                a.original_token_number,
                a.current_token_number,
                a.status AS appointment_status,
                b.branch_name,
                t.treatment_name,
                s.slot_name,
                COALESCE(sto.override_start_time, s.start_time) AS start_time,
                COALESCE(sto.override_end_time, s.end_time) AS end_time
             FROM tbl_consultations c
             JOIN tbl_appointments a ON a.appointment_id = c.appointment_id
             ${getAppointmentPatientJoin()}
             JOIN master_users d ON d.id = c.doctor_id
             JOIN master_clinic_branches b ON b.id = a.fk_branch_id
             JOIN master_treatments t ON t.id = a.fk_treatment_id
             JOIN master_slots s ON s.id = a.fk_slot_id
             LEFT JOIN tbl_doctor_slot_time_overrides sto
               ON sto.fk_branch_id = a.fk_branch_id
              AND sto.fk_slot_id = a.fk_slot_id
              AND sto.appointment_date = a.appointment_date
              AND sto.status = 'ACTIVE'
             JOIN tbl_medical_prescription_pricing mpp ON mpp.consultation_id = c.id
             ${whereClause}
             ORDER BY mpp.updated_at DESC, c.id DESC
             LIMIT ${pageSize} OFFSET ${offset}`,
            params
        ),
        query(
            `SELECT COUNT(*) AS total
             FROM tbl_bills b
             JOIN master_users p ON p.id = b.patient_id
             LEFT JOIN tbl_consultations c ON c.id = b.consultation_id
             ${repeatWhereClause}`,
            repeatParams
        ),
        query(
            `SELECT
                b.id AS bill_id,
                b.bill_number,
                b.consultation_id,
                b.patient_id,
                b.fk_branch_id,
                b.total_amount,
                b.payment_status,
                b.remark,
                b.delivery_mode,
                b.delivery_details_json,
                b.created_at,
                b.updated_at,
                p.full_name AS patient_full_name,
                p.mobile_no AS patient_mobile_no,
                p.uuid AS patient_uuid,
                p.age AS patient_age,
                p.gender AS patient_gender,
                br.branch_name,
                c.doctor_id,
                d.full_name AS doctor_name,
                t.treatment_name
             FROM tbl_bills b
             JOIN master_users p ON p.id = b.patient_id
             LEFT JOIN master_clinic_branches br ON br.id = b.fk_branch_id
             LEFT JOIN tbl_consultations c ON c.id = b.consultation_id
             LEFT JOIN tbl_appointments a ON a.appointment_id = c.appointment_id
             LEFT JOIN master_users d ON d.id = c.doctor_id
             LEFT JOIN master_treatments t ON t.id = a.fk_treatment_id
             ${repeatWhereClause}
             ORDER BY b.created_at DESC, b.id DESC
             LIMIT ${pageSize} OFFSET ${offset}`,
            repeatParams
        ),
    ]);

    const repeatBillIds = repeatRows.map((row) => row.bill_id);
    const repeatItemRows = repeatBillIds.length > 0
        ? await query(
            `SELECT bill_id, consultation_medication_id, item_type, item_name, amount
             FROM tbl_bill_items
             WHERE bill_id IN (${repeatBillIds.map(() => '?').join(',')})
             ORDER BY id ASC`,
            repeatBillIds
        )
        : [];
    const repeatItemsByBillId = new Map();
    repeatItemRows.forEach((item) => {
        const billItems = repeatItemsByBillId.get(item.bill_id) || [];
        billItems.push(item);
        repeatItemsByBillId.set(item.bill_id, billItems);
    });

    const total = Number(countRows[0]?.total || 0) + Number(repeatCountRows[0]?.total || 0);
    const totalPages = Math.max(1, Math.ceil(total / pageSize));

    const prescriptionData = await Promise.all(rows.map(buildMedicalPrescriptionListItem));
    const repeatData = repeatRows.map((row) => {
        const billItems = repeatItemsByBillId.get(row.bill_id) || [];
        const medicineItems = billItems.filter((item) => String(item.item_name || '').toLowerCase() !== 'courier charge');
        const courierItem = billItems.find((item) => String(item.item_name || '').toLowerCase() === 'courier charge');
        let deliveryDetails = null;
        try {
            deliveryDetails = row.delivery_details_json
                ? (typeof row.delivery_details_json === 'string' ? JSON.parse(row.delivery_details_json) : row.delivery_details_json)
                : null;
        } catch (_error) {
            deliveryDetails = null;
        }

        return {
            record_type: 'REPEAT_MEDICINE',
            is_repeat_medicine: true,
            bill_id: row.bill_id,
            consultation_id: `repeat-${row.bill_id}`,
            doctor_name: row.doctor_name,
            doctor_id: row.doctor_id,
            patient: {
                full_name: row.patient_full_name,
                mobile_no: row.patient_mobile_no,
                uuid: row.patient_uuid,
                age: row.patient_age,
                gender: row.patient_gender,
            },
            appointment: {
                auid: row.bill_number,
                appointment_date: row.created_at,
                slot_name: 'Repeat Medicine',
                branch_name: row.branch_name,
                token_number: null,
                display_token_display: 'Repeat',
            },
            prescription: {
                medications: medicineItems.map((item, index) => ({
                    consultation_medication_id: item.consultation_medication_id || `repeat-${row.bill_id}-${index}`,
                    medicine_type: 'TEXT',
                    medicine_value: item.item_name,
                    added_by_role: item.item_type === 'ADDITIONAL_MEDICATION' ? 'MEDICAL' : 'DOCTOR',
                })),
                tests: [],
                pricing: {
                    total_amount: row.total_amount,
                    remark: row.remark,
                    medications: medicineItems.map((item, index) => ({
                        consultation_medication_id: item.consultation_medication_id || `repeat-${row.bill_id}-${index}`,
                        medicine_value: item.item_name,
                        amount: item.amount,
                        dispense_status: 'ACTIVE',
                    })),
                },
                courier_charge: courierItem?.amount || 0,
                delivery_mode: row.delivery_mode,
                delivery_details: deliveryDetails,
                payment_status: row.payment_status,
            },
            updated_at: row.updated_at,
            created_at: row.created_at,
        };
    });
    const data = [...prescriptionData, ...repeatData]
        .sort((a, b) => new Date(b.updated_at || b.created_at || b.appointment?.appointment_date || 0).getTime()
            - new Date(a.updated_at || a.created_at || a.appointment?.appointment_date || 0).getTime())
        .slice(0, pageSize);

    return res.status(200).json({
        success: true,
        message: 'Priced medical prescriptions fetched successfully',
        data,
        meta: {
            page,
            page_size: pageSize,
            total,
            total_pages: totalPages,
            filters: {
                pricing_status: 'priced',
                branch_id: branchId,
                appointment_date: appointmentDate,
                patient_search: patientSearch,
            },
        },
    });
});

const getMedicalPrescription = asyncHandler(async (req, res) => {
    const consultationId = toPositiveInt(req.params.consultation_id);
    if (!consultationId) {
        throw new AppError('Valid consultation_id is required', 400);
    }

    const detail = await getMedicalPrescriptionDetail(consultationId, req.selectedBranchId || null);
    if (!detail) {
        throw new AppError('Prescription not found', 404);
    }

    return res.status(200).json({
        success: true,
        message: 'Medical prescription fetched successfully',
        data: detail,
    });
});

const saveMedicalPrescriptionPricing = asyncHandler(async (req, res) => {
    const consultationId = toPositiveInt(req.params.consultation_id || req.body?.consultation_id);
    const remark = req.body?.remark ? String(req.body.remark).trim() : null;
    const medications = Array.isArray(req.body?.medications) ? req.body.medications : null;
    const additionalMedications = Array.isArray(req.body?.additional_medications) ? req.body.additional_medications : [];
    const processAfterSave = toBoolean(req.body?.process_after_save);
    const payment = normalizeMedicalPaymentPayload(req.body?.payment);
    const submittedRequestKey = String(
        req.get('Idempotency-Key') || req.body?.request_key || randomUUID()
    ).trim().slice(0, 100);
    const requestKey = submittedRequestKey || randomUUID();

    if (!consultationId) {
        throw new AppError('Valid consultation_id is required', 400);
    }

    if (!medications) {
        throw new AppError('medications array is required', 400);
    }

    if (payment && !processAfterSave) {
        throw new AppError('payment can only be submitted when process_after_save is true', 400);
    }

    const normalizedAdditionalItems = additionalMedications.map((item, index) => {
        const medicineValue = String(item?.medicine_value || '').trim();
        const amount = toPositiveAmount(item?.amount);
        const consultationMedicationId = item?.consultation_medication_id ? toPositiveInt(item.consultation_medication_id) : null;

        if (!medicineValue) {
            throw new AppError(`additional_medications[${index}].medicine_value is required`, 400);
        }

        if (amount === null) {
            throw new AppError(`additional_medications[${index}].amount must be a valid non-negative number`, 400);
        }

        return {
            consultation_medication_id: consultationMedicationId,
            medicine_value: medicineValue,
            amount,
        };
    });

    let finalizedBillId = null;
    let finalizedPaymentStatus = null;
    let replayedRequest = false;

    await withTransaction(async (connection) => {
        const [consultationRows] = await connection.execute(
            `SELECT id, workflow_status
             FROM tbl_consultations
             WHERE id = ?
             LIMIT 1
             FOR UPDATE`,
            [consultationId]
        );

        if (consultationRows.length === 0) {
            throw new AppError('Prescription not found', 404);
        }

        try {
            await connection.execute(
                `INSERT INTO tbl_medical_dispensing_requests
                 (consultation_id, request_key, request_type, created_by)
                 VALUES (?, ?, ?, ?)`,
                [consultationId, requestKey, processAfterSave ? 'PROCESS' : 'SAVE', req.user.id]
            );
        } catch (error) {
            if (error?.code === 'ER_DUP_ENTRY') {
                replayedRequest = true;
                return;
            }
            throw error;
        }

        const [paidBillRows] = await connection.execute(
            `SELECT id
             FROM tbl_bills
             WHERE consultation_id = ?
               AND bill_type = 'MEDICATION'
               AND status = 'ACTIVE'
               AND (payment_status = 'PAID' OR paid_amount > 0)
             LIMIT 1
             FOR UPDATE`,
            [consultationId]
        );

        ensureDispensingMutationAllowed({
            workflowStatus: consultationRows[0].workflow_status,
            hasPaidBill: paidBillRows.length > 0,
        });

        const [existingPricingRows] = await connection.execute(
            `SELECT id
             FROM tbl_medical_prescription_pricing
             WHERE consultation_id = ?
             LIMIT 1
             FOR UPDATE`,
            [consultationId]
        );

        const [prescribedMedications] = await connection.execute(
            `SELECT id AS consultation_medication_id, medicine_value
             FROM tbl_consultation_medications
             WHERE consultation_id = ?
               AND added_by_role = 'DOCTOR'
             ORDER BY id ASC
             FOR UPDATE`,
            [consultationId]
        );

        let pricingId = existingPricingRows[0]?.id || null;
        let existingItems = [];

        if (pricingId) {
            [existingItems] = await connection.execute(
                `SELECT
                    mpi.id AS pricing_item_id,
                    mpi.consultation_medication_id,
                    mpi.medicine_value,
                    mpi.amount,
                    mpi.dispense_status,
                    mpi.void_reason,
                    mpi.voided_by,
                    mpi.voided_at,
                    mpi.version
                 FROM tbl_medical_prescription_pricing_items mpi
                 JOIN tbl_consultation_medications cm
                   ON cm.id = mpi.consultation_medication_id
                  AND cm.consultation_id = ?
                  AND cm.added_by_role = 'DOCTOR'
                 WHERE mpi.pricing_id = ?
                 ORDER BY mpi.id ASC
                 FOR UPDATE`,
                [consultationId, pricingId]
            );
        }

        const normalizedItems = validatePrescribedDispensingItems({
            submittedItems: medications,
            prescribedMedications,
            existingItems,
        });

        const [testRows] = await connection.execute(
            `SELECT id, amount
             FROM tbl_consultation_tests
             WHERE consultation_id = ?
             ORDER BY id ASC
             FOR UPDATE`,
            [consultationId]
        );

        const totalAmount = calculateDispensingTotal({
            prescribedItems: normalizedItems,
            additionalItems: normalizedAdditionalItems,
            tests: testRows,
        });

        if (existingPricingRows.length > 0) {
            await connection.execute(
                `UPDATE tbl_medical_prescription_pricing
                 SET total_amount = ?,
                     remark = ?,
                     updated_by = ?
                 WHERE id = ?`,
                [totalAmount, remark, req.user.id, pricingId]
            );
        } else {
            const [insertPricing] = await connection.execute(
                `INSERT INTO tbl_medical_prescription_pricing
                 (consultation_id, total_amount, remark, created_by, updated_by)
                 VALUES (?, ?, ?, ?, ?)`,
                [consultationId, totalAmount, remark, req.user.id, req.user.id]
            );
            pricingId = insertPricing.insertId;
        }

        for (const item of normalizedItems) {
            const existing = item.existing;
            const eventType = resolveDispensingEventType({
                existing,
                amount: item.amount,
                dispenseStatus: item.dispense_status,
                voidReason: item.void_reason,
            });
            let pricingItemId = existing?.pricing_item_id || null;

            if (existing && eventType) {
                const [updateResult] = await connection.execute(
                    `UPDATE tbl_medical_prescription_pricing_items
                     SET amount = ?,
                         medicine_value = ?,
                         dispense_status = ?,
                         void_reason = ?,
                         voided_by = CASE WHEN ? = 'VOID' THEN ? ELSE NULL END,
                         voided_at = CASE WHEN ? = 'VOID' THEN NOW() ELSE NULL END,
                         version = version + 1
                     WHERE id = ?
                       AND version = ?`,
                    [
                        item.amount,
                        item.medicine_value,
                        item.dispense_status,
                        item.void_reason,
                        item.dispense_status,
                        req.user.id,
                        item.dispense_status,
                        existing.pricing_item_id,
                        existing.version,
                    ]
                );

                if (updateResult.affectedRows !== 1) {
                    throw new AppError(`Medication ${item.consultation_medication_id} was changed by another user. Please reload.`, 409);
                }
            } else if (!existing) {
                const [insertItem] = await connection.execute(
                    `INSERT INTO tbl_medical_prescription_pricing_items
                     (pricing_id, consultation_medication_id, medicine_value, amount,
                      dispense_status, void_reason, voided_by, voided_at, version)
                     VALUES (?, ?, ?, ?, ?, ?,
                             CASE WHEN ? = 'VOID' THEN ? ELSE NULL END,
                             CASE WHEN ? = 'VOID' THEN NOW() ELSE NULL END, 1)`,
                    [
                        pricingId,
                        item.consultation_medication_id,
                        item.medicine_value,
                        item.amount,
                        item.dispense_status,
                        item.void_reason,
                        item.dispense_status,
                        req.user.id,
                        item.dispense_status,
                    ]
                );
                pricingItemId = insertItem.insertId;
            }

            if (eventType) {
                await connection.execute(
                    `INSERT INTO tbl_medical_dispensing_item_events
                     (pricing_item_id, consultation_id, consultation_medication_id, medicine_value,
                      event_type, old_amount, new_amount, old_status, new_status, reason,
                      actor_user_id, actor_role, request_key)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    [
                        pricingItemId,
                        consultationId,
                        item.consultation_medication_id,
                        item.medicine_value,
                        eventType,
                        existing?.amount ?? null,
                        item.amount,
                        existing?.dispense_status || null,
                        item.dispense_status,
                        item.void_reason,
                        req.user.id,
                        req.user.role_code,
                        requestKey,
                    ]
                );
            }
        }

        const [oldAdditionalRows] = await connection.execute(
            `SELECT id
             FROM tbl_consultation_medications
             WHERE consultation_id = ?
               AND medicine_type = 'TEXT'
               AND added_by_role = 'MEDICAL'
             FOR UPDATE`,
            [consultationId]
        );

        if (oldAdditionalRows.length > 0) {
            const oldAdditionalIds = oldAdditionalRows.map((row) => Number(row.id));
            const placeholders = oldAdditionalIds.map(() => '?').join(', ');
            await connection.execute(
                `DELETE FROM tbl_medical_prescription_pricing_items
                 WHERE pricing_id = ?
                   AND consultation_medication_id IN (${placeholders})`,
                [pricingId, ...oldAdditionalIds]
            );
        }

        await connection.execute(
            `DELETE FROM tbl_consultation_medications
             WHERE consultation_id = ?
               AND medicine_type = 'TEXT'
               AND added_by_role = 'MEDICAL'`,
            [consultationId]
        );

        for (const item of normalizedAdditionalItems) {
            const [insertMedication] = await connection.execute(
                `INSERT INTO tbl_consultation_medications
                 (consultation_id, medicine_type, medicine_value, remark, added_by_role)
                 VALUES (?, 'TEXT', ?, NULL, 'MEDICAL')`,
                [consultationId, item.medicine_value]
            );

            await connection.execute(
                `INSERT INTO tbl_medical_prescription_pricing_items
                 (pricing_id, consultation_medication_id, medicine_value, amount, dispense_status, version)
                 VALUES (?, ?, ?, ?, 'ACTIVE', 1)`,
                [pricingId, insertMedication.insertId, item.medicine_value, item.amount]
            );
        }

        if (!processAfterSave) {
            const [existingUnpaidBillRows] = await connection.execute(
                `SELECT id
                 FROM tbl_bills
                 WHERE consultation_id = ?
                   AND bill_type = 'MEDICATION'
                   AND status = 'ACTIVE'
                   AND payment_status = 'UNPAID'
                   AND paid_amount = 0
                 LIMIT 1
                 FOR UPDATE`,
                [consultationId]
            );

            if (existingUnpaidBillRows.length > 0) {
                const refreshedBill = await createMedicationBillFromConsultation({
                    connection,
                    consultationId,
                    createdByUserId: req.user.id,
                });
                finalizedBillId = refreshedBill.billId;
            }
        }

        if (processAfterSave) {
            const finalized = await finalizeMedicalPrescription({
                connection,
                consultationId,
                medicalUserId: req.user.id,
                payment,
            });

            finalizedBillId = finalized.billId;
            finalizedPaymentStatus = finalized.paymentStatus;
        }
    });

    if (replayedRequest && processAfterSave) {
        const existingBillRows = await query(
            `SELECT id
             FROM tbl_bills
             WHERE consultation_id = ?
               AND bill_type = 'MEDICATION'
               AND status = 'ACTIVE'
             LIMIT 1`,
            [consultationId]
        );
        finalizedBillId = existingBillRows[0]?.id || null;
    }

    const detail = await getMedicalPrescriptionDetail(consultationId, req.selectedBranchId || null);
    const bill = finalizedBillId ? await getBillDetailById(finalizedBillId) : null;

    if (processAfterSave && !replayedRequest) {
        await notifyMedicalPrescriptionProcessed({ consultationId, detail });
    }

    return res.status(200).json({
        success: true,
        message: replayedRequest
            ? 'Dispensing request already completed'
            : processAfterSave
            ? 'Medical prescription priced, processed and payment updated successfully'
            : 'Medical prescription pricing saved successfully',
        data: {
            ...detail,
            bill,
            payment_status: finalizedPaymentStatus,
        },
    });
});

const processMedicalPrescription = asyncHandler(async (req, res) => {
    const consultationId = toPositiveInt(req.params.consultation_id);
    if (!consultationId) {
        throw new AppError('Valid consultation_id is required', 400);
    }

    let finalizedBillId = null;

    await withTransaction(async (connection) => {
        const finalized = await finalizeMedicalPrescription({
            connection,
            consultationId,
            medicalUserId: req.user.id,
        });
        finalizedBillId = finalized.billId;
    });

    const detail = await getMedicalPrescriptionDetail(consultationId, req.selectedBranchId || null);
    const bill = finalizedBillId ? await getBillDetailById(finalizedBillId) : null;
    await notifyMedicalPrescriptionProcessed({ consultationId, detail });

    return res.status(200).json({
        success: true,
        message: 'Prescription processed successfully',
        data: {
            ...detail,
            bill,
        },
    });
});

const downloadMedicalProductImportTemplate = asyncHandler(async (_req, res) => {
    const buffer = await createMedicalProductTemplateWorkbook();

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="medical_products_import_template.xlsx"');
    return res.status(200).send(Buffer.from(buffer));
});

const importMedicalProducts = asyncHandler(async (req, res) => {
    if (!req.file?.buffer) {
        throw new AppError('Excel file is required', 400);
    }

    const result = await importMedicalProductsFromWorkbook(req.file.buffer);

    return res.status(200).json({
        success: true,
        message: 'Medical products import completed',
        data: {
            ...result,
            total_skipped_rows: result.skipped_rows.length,
        },
    });
});

const listMedicalProductMasters = asyncHandler(async (req, res) => {
    const result = await listMedicalProducts({
        page: req.query.page,
        limit: req.query.limit,
        search: req.query.search,
        sourceType: req.query.source_type,
        status: req.query.status,
    });

    return res.status(200).json({
        success: true,
        message: 'Medical products fetched successfully',
        data: result.rows,
        pagination: result.pagination,
    });
});

const getMedicalProductMasterSummary = asyncHandler(async (_req, res) => {
    const summary = await getMedicalProductSummary();

    return res.status(200).json({
        success: true,
        message: 'Medical product summary fetched successfully',
        data: summary,
    });
});

const getMedicalProductMaster = asyncHandler(async (req, res) => {
    const productId = toPositiveInt(req.params.id);
    if (!productId) {
        throw new AppError('Valid product id is required', 400);
    }

    const product = await getMedicalProductById(productId);
    if (!product) {
        throw new AppError('Medical product not found', 404);
    }

    return res.status(200).json({
        success: true,
        message: 'Medical product fetched successfully',
        data: product,
    });
});

const createMedicalProductMaster = asyncHandler(async (req, res) => {
    const product = await createMedicalProduct(req.body);

    return res.status(201).json({
        success: true,
        message: 'Medical product created successfully',
        data: product,
    });
});

const updateMedicalProductMaster = asyncHandler(async (req, res) => {
    const productId = toPositiveInt(req.params.id);
    if (!productId) {
        throw new AppError('Valid product id is required', 400);
    }

    const product = await updateMedicalProduct(productId, req.body);

    return res.status(200).json({
        success: true,
        message: 'Medical product updated successfully',
        data: product,
    });
});

const deleteMedicalProductMaster = asyncHandler(async (req, res) => {
    const productId = toPositiveInt(req.params.id);
    if (!productId) {
        throw new AppError('Valid product id is required', 400);
    }

    const product = await deleteMedicalProduct(productId);

    return res.status(200).json({
        success: true,
        message: 'Medical product deleted successfully',
        data: product,
    });
});

module.exports = {
    buildMedicalPrescriptionListItemResponse,
    listRepeatMedicinePatients,
    getRepeatMedicineLastPrescription,
    createRepeatMedicineBillController,
    listMedicalPrescriptions,
    listPricedMedicalPrescriptions,
    getMedicalPrescription,
    saveMedicalPrescriptionPricing,
    processMedicalPrescription,
    downloadMedicalProductImportTemplate,
    importMedicalProducts,
    listMedicalProductMasters,
    getMedicalProductMasterSummary,
    getMedicalProductMaster,
    createMedicalProductMaster,
    updateMedicalProductMaster,
    deleteMedicalProductMaster,
};
