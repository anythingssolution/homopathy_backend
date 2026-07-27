const { query, withTransaction } = require('../../config/db');
const AppError = require('../../utils/AppError');
const asyncHandler = require('../../utils/asyncHandler');
const { createNotificationsForRole, createNotificationForUser } = require('../../utils/notificationService');
const {
    createMedicationBillFromConsultation,
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
            created_at,
            updated_at
         FROM tbl_medical_prescription_pricing_items
         WHERE pricing_id = ?
         ORDER BY id ASC`,
        [pricingRows[0].pricing_id]
    );

    return {
        ...pricingRows[0],
        medications: items,
    };
};

const buildMedicalPrescriptionListItem = async (row) => {
    const detail = await getMedicalPrescriptionDetail(row.consultation_id, row.fk_branch_id || null);
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

    return {
        ...rows[0],
        medications: Array.from(medicationMap.values()),
        tests: testRows,
        pricing: await getMedicalPricingByConsultationId(consultationId),
    };
};

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

    const whereClause = `WHERE ${conditions.join(' AND ')}`;

    const rows = await query(
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
         ${pricingJoin}
         ${whereClause}
         ORDER BY c.sent_to_medical_at DESC, c.id DESC`,
        params
    );

    const data = await Promise.all(rows.map(buildMedicalPrescriptionListItem));

    return res.status(200).json({
        success: true,
        message: 'Medical prescriptions fetched successfully',
        data,
        meta: {
            total: data.length,
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

    if (branchId) {
        conditions.push('a.fk_branch_id = ?');
        params.push(branchId);
    }

    if (appointmentDate) {
        conditions.push('a.appointment_date = ?');
        params.push(appointmentDate);
    }

    if (patientSearch) {
        conditions.push('(COALESCE(fm.full_name, p.full_name) LIKE ? OR p.full_name LIKE ? OR p.mobile_no LIKE ? OR p.uuid LIKE ? OR a.auid LIKE ?)');
        params.push(`%${patientSearch}%`, `%${patientSearch}%`, `%${patientSearch}%`, `%${patientSearch}%`, `%${patientSearch}%`);
    }

    const whereClause = `WHERE ${conditions.join(' AND ')}`;

    const [countRows, rows] = await Promise.all([
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
    ]);

    const total = Number(countRows[0]?.total || 0);
    const totalPages = Math.max(1, Math.ceil(total / pageSize));

    const data = await Promise.all(rows.map(buildMedicalPrescriptionListItem));

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
    const totalAmount = toPositiveAmount(req.body?.amount);
    const remark = req.body?.remark ? String(req.body.remark).trim() : null;
    const medications = Array.isArray(req.body?.medications) ? req.body.medications : null;
    const additionalMedications = Array.isArray(req.body?.additional_medications) ? req.body.additional_medications : [];
    const processAfterSave = toBoolean(req.body?.process_after_save);
    const payment = normalizeMedicalPaymentPayload(req.body?.payment);

    if (!consultationId) {
        throw new AppError('Valid consultation_id is required', 400);
    }

    if (totalAmount === null) {
        throw new AppError('amount must be a valid non-negative number', 400);
    }

    if (!medications || medications.length === 0) {
        throw new AppError('medications array is required', 400);
    }

    if (payment && !processAfterSave) {
        throw new AppError('payment can only be submitted when process_after_save is true', 400);
    }

    const normalizedItems = medications.map((item, index) => {
        const medicineValue = String(item?.medicine_value || '').trim();
        const amount = toPositiveAmount(item?.amount);
        const consultationMedicationId = item?.consultation_medication_id ? toPositiveInt(item.consultation_medication_id) : null;

        if (!medicineValue) {
            throw new AppError(`medications[${index}].medicine_value is required`, 400);
        }

        if (amount === null) {
            throw new AppError(`medications[${index}].amount must be a valid non-negative number`, 400);
        }

        return {
            consultation_medication_id: consultationMedicationId,
            medicine_value: medicineValue,
            amount,
        };
    });

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

        const [existingPricingRows] = await connection.execute(
            `SELECT id
             FROM tbl_medical_prescription_pricing
             WHERE consultation_id = ?
             LIMIT 1
             FOR UPDATE`,
            [consultationId]
        );

        let pricingId = null;

        if (existingPricingRows.length > 0) {
            pricingId = existingPricingRows[0].id;
            await connection.execute(
                `UPDATE tbl_medical_prescription_pricing
                 SET total_amount = ?,
                     remark = ?,
                     updated_by = ?
                 WHERE id = ?`,
                [totalAmount, remark, req.user.id, pricingId]
            );
            await connection.execute(
                `DELETE FROM tbl_medical_prescription_pricing_items
                 WHERE pricing_id = ?`,
                [pricingId]
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

        await connection.execute(
            `DELETE FROM tbl_consultation_medications
             WHERE consultation_id = ?
               AND medicine_type = 'TEXT'
               AND added_by_role = 'MEDICAL'`,
            [consultationId]
        );

        const finalPricingItems = [...normalizedItems];

        for (const item of normalizedAdditionalItems) {
            const [insertMedication] = await connection.execute(
                `INSERT INTO tbl_consultation_medications
                 (consultation_id, medicine_type, medicine_value, remark, added_by_role)
                 VALUES (?, 'TEXT', ?, NULL, 'MEDICAL')`,
                [consultationId, item.medicine_value]
            );

            finalPricingItems.push({
                consultation_medication_id: insertMedication.insertId,
                medicine_value: item.medicine_value,
                amount: item.amount,
            });
        }

        for (const item of finalPricingItems) {
            await connection.execute(
                `INSERT INTO tbl_medical_prescription_pricing_items
                 (pricing_id, consultation_medication_id, medicine_value, amount)
                 VALUES (?, ?, ?, ?)`,
                [pricingId, item.consultation_medication_id, item.medicine_value, item.amount]
            );
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

    const detail = await getMedicalPrescriptionDetail(consultationId, req.selectedBranchId || null);
    const bill = finalizedBillId ? await getBillDetailById(finalizedBillId) : null;

    if (processAfterSave) {
        await notifyMedicalPrescriptionProcessed({ consultationId, detail });
    }

    return res.status(200).json({
        success: true,
        message: processAfterSave
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
