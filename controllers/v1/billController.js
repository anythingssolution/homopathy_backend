const { query, withTransaction } = require('../../config/db');
const AppError = require('../../utils/AppError');
const asyncHandler = require('../../utils/asyncHandler');
const {
    createConsultationBillForAppointment,
    collectConsultationBillPayment,
    createMedicationBillFromConsultation,
    getBillDetailById,
    getAppointmentBillingSummaryByAppointmentId,
} = require('../../services/billingService');
const { decorateTokenFields } = require('../../utils/tokenDisplay');
const { parsePagination, resolvePagination, buildPaginationMeta } = require('../../utils/pagination');

const toPositiveInt = (value) => {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) {
        return null;
    }

    return parsed;
};

const buildBillListQuery = ({ actor, filters }) => {
    const conditions = ['b.status = \'ACTIVE\''];
    const params = [];

    if (filters.type) {
        conditions.push('b.bill_type = ?');
        params.push(filters.type);
    }

    if (filters.paymentMode) {
        conditions.push('EXISTS (SELECT 1 FROM tbl_bill_payments bp_filter WHERE bp_filter.bill_id = b.id AND UPPER(bp_filter.payment_mode) = ? AND bp_filter.status = \'SUCCESS\')');
        params.push(filters.paymentMode);
    }

    if (filters.appointmentId) {
        conditions.push('b.appointment_id = ?');
        params.push(filters.appointmentId);
    }

    if (filters.paymentStatus) {
        conditions.push('b.payment_status = ?');
        params.push(filters.paymentStatus);
    }

    if (filters.branchId) {
        conditions.push('b.fk_branch_id = ?');
        params.push(filters.branchId);
    }

    if (filters.fromDate) {
        conditions.push('COALESCE(a.appointment_date, DATE(b.created_at)) >= ?');
        params.push(filters.fromDate);
    }

    if (filters.toDate) {
        conditions.push('COALESCE(a.appointment_date, DATE(b.created_at)) <= ?');
        params.push(filters.toDate);
    }

    if (actor.role === 'patient') {
        conditions.push('b.patient_id = ?');
        params.push(actor.id);
    } else if (actor.role === 'doctor') {
        conditions.push('c.doctor_id = ?');
        params.push(actor.id);
    } else if (filters.patientId) {
        conditions.push('b.patient_id = ?');
        params.push(filters.patientId);
    }

    if (filters.patientSearch) {
        conditions.push('(COALESCE(fm.full_name, p.full_name) LIKE ? OR p.full_name LIKE ? OR p.mobile_no LIKE ? OR p.uuid LIKE ? OR a.auid LIKE ? OR b.bill_number LIKE ?)');
        params.push(
            `%${filters.patientSearch}%`,
            `%${filters.patientSearch}%`,
            `%${filters.patientSearch}%`,
            `%${filters.patientSearch}%`,
            `%${filters.patientSearch}%`,
            `%${filters.patientSearch}%`
        );
    }

    if (actor.role === 'receptionist') {
        conditions.push('b.bill_type = \'CONSULTATION\'');
    }

    if (actor.role === 'medical') {
        conditions.push('b.bill_type = \'MEDICATION\'');
    }

    return {
        whereClause: `WHERE ${conditions.join(' AND ')}`,
        params,
    };
};

const createConsultationBill = asyncHandler(async (req, res) => {
    const appointmentId = toPositiveInt(req.body?.appointment_id);

    if (!appointmentId) {
        throw new AppError('Valid appointment_id is required', 400);
    }

    const appointmentRows = await query(
        `SELECT appointment_id, fk_patient_id, fk_branch_id, fk_treatment_id
         FROM tbl_appointments
         WHERE appointment_id = ?
         LIMIT 1`,
        [appointmentId]
    );

    if (appointmentRows.length === 0) {
        throw new AppError('Appointment not found', 404);
    }

    const appointment = appointmentRows[0];

    if (req.selectedBranchId && Number(appointment.fk_branch_id) !== Number(req.selectedBranchId)) {
        throw new AppError('You can create consultation bills only for the selected branch', 403);
    }

    if (req.user.role === 'patient' && Number(appointment.fk_patient_id) !== Number(req.user.id)) {
        throw new AppError('You can only create bills for your own appointments', 403);
    }

    const result = await withTransaction(async (connection) => createConsultationBillForAppointment({
        connection,
        appointmentId: appointment.appointment_id,
        patientId: appointment.fk_patient_id,
        branchId: appointment.fk_branch_id,
        treatmentId: appointment.fk_treatment_id,
        actorUserId: req.user.id,
    }));

    const bill = await getBillDetailById(result.billId);

    return res.status(result.created ? 201 : 200).json({
        success: true,
        message: result.created ? 'Consultation bill created successfully' : 'Consultation bill already exists',
        data: bill,
    });
});

const collectConsultationPayment = asyncHandler(async (req, res) => {
    const billId = toPositiveInt(req.params.bill_id);

    if (!billId) {
        throw new AppError('Valid bill_id is required', 400);
    }

    const { payment_mode, amount, transaction_reference = null, remark = null } = req.body || {};

    const result = await withTransaction(async (connection) => collectConsultationBillPayment({
        connection,
        billId,
        amount,
        paymentMode: payment_mode,
        transactionReference: transaction_reference,
        remark: remark ? String(remark).trim() : null,
        collectedByUserId: req.user.id,
        collectedByRole: req.user.role_code,
    }));

    const bill = await getBillDetailById(result.billId);

    return res.status(200).json({
        success: true,
        message: 'Consultation payment collected successfully',
        data: bill,
    });
});

const createMedicationBill = asyncHandler(async (req, res) => {
    const consultationId = toPositiveInt(req.body?.consultation_id);

    if (!consultationId) {
        throw new AppError('Valid consultation_id is required', 400);
    }

    if (req.selectedBranchId) {
        const consultationRows = await query(
            `SELECT a.fk_branch_id
             FROM tbl_consultations c
             JOIN tbl_appointments a ON a.appointment_id = c.appointment_id
             WHERE c.id = ?
             LIMIT 1`,
            [consultationId]
        );

        if (consultationRows.length === 0) {
            throw new AppError('Consultation not found', 404);
        }

        if (Number(consultationRows[0].fk_branch_id) !== Number(req.selectedBranchId)) {
            throw new AppError('You can create medication bills only for the selected branch', 403);
        }
    }

    const result = await withTransaction(async (connection) => createMedicationBillFromConsultation({
        connection,
        consultationId,
        createdByUserId: req.user.id,
        remark: req.body?.remark ? String(req.body.remark).trim() : null,
    }));

    const bill = await getBillDetailById(result.billId);

    return res.status(result.created ? 201 : 200).json({
        success: true,
        message: result.created ? 'Medication bill created successfully' : 'Medication bill already exists',
        data: bill,
    });
});

const listBills = asyncHandler(async (req, res) => {
    const rawType = req.query.type ? String(req.query.type).trim().toUpperCase() : null;
    const type = rawType && ['CONSULTATION', 'MEDICATION'].includes(rawType) ? rawType : rawType === null ? null : undefined;
    const paymentStatusRaw = req.query.payment_status ? String(req.query.payment_status).trim().toUpperCase() : null;
    const paymentStatus = paymentStatusRaw && ['UNPAID', 'PAID', 'PARTIAL'].includes(paymentStatusRaw)
        ? paymentStatusRaw
        : paymentStatusRaw === null
            ? null
            : undefined;
    const rawPaymentMode = req.query.payment_mode ? String(req.query.payment_mode).trim().toUpperCase() : null;
    const paymentMode = rawPaymentMode && ['CASH', 'ONLINE'].includes(rawPaymentMode)
        ? rawPaymentMode
        : rawPaymentMode === null
            ? null
            : undefined;
    const fromDate = req.query.from_date ? String(req.query.from_date).trim() : null;
    const toDate = req.query.to_date ? String(req.query.to_date).trim() : null;
    const patientSearch = req.query.patient_search ? String(req.query.patient_search).trim() : null;
    const appointmentId = req.query.appointment_id !== undefined ? toPositiveInt(req.query.appointment_id) : null;
    const patientId = req.query.patient_id !== undefined ? toPositiveInt(req.query.patient_id) : null;
    const branchId = req.query.branch_id !== undefined ? toPositiveInt(req.query.branch_id) : null;

    if (rawType && type === undefined) {
        throw new AppError('type must be CONSULTATION or MEDICATION', 400);
    }

    if (paymentStatusRaw && paymentStatus === undefined) {
        throw new AppError('payment_status must be UNPAID, PAID or PARTIAL', 400);
    }

    if (rawPaymentMode && paymentMode === undefined) {
        throw new AppError('payment_mode must be CASH or ONLINE', 400);
    }

    if (req.query.appointment_id !== undefined && !appointmentId) {
        throw new AppError('appointment_id must be a positive integer', 400);
    }

    if (req.query.patient_id !== undefined && !patientId) {
        throw new AppError('patient_id must be a positive integer', 400);
    }

    if (req.query.branch_id !== undefined && !branchId) {
        throw new AppError('branch_id must be a positive integer', 400);
    }

    if (fromDate && !/^\d{4}-\d{2}-\d{2}$/.test(fromDate)) {
        throw new AppError('from_date must be in YYYY-MM-DD format', 400);
    }

    if (toDate && !/^\d{4}-\d{2}-\d{2}$/.test(toDate)) {
        throw new AppError('to_date must be in YYYY-MM-DD format', 400);
    }

    const { whereClause, params } = buildBillListQuery({
        actor: req.user,
        filters: {
            type,
            paymentStatus,
            paymentMode,
            fromDate,
            toDate,
            patientSearch,
            appointmentId,
            patientId,
            branchId,
        },
    });

    const { page, pageSize } = parsePagination(req.query, { defaultPageSize: 50, maxPageSize: 1000 });
    const countRows = await query(
        `SELECT COUNT(*) AS total
         FROM tbl_bills b
         LEFT JOIN tbl_appointments a ON a.appointment_id = b.appointment_id
         LEFT JOIN tbl_consultations c ON c.appointment_id = b.appointment_id
         LEFT JOIN master_users p ON p.id = COALESCE(a.fk_patient_id, b.patient_id)
         LEFT JOIN tbl_patient_family_members fm
           ON fm.id = a.fk_patient_family_member_id
         ${whereClause}`,
        params
    );
    const pagination = resolvePagination({
        page,
        pageSize,
        total: Number(countRows[0]?.total || 0),
    });

    const rows = await query(
        `SELECT
            b.id AS bill_id,
            b.bill_number,
            b.bill_type,
            b.appointment_id,
            b.consultation_id,
            b.patient_id,
            b.fk_branch_id AS branch_id,
            b.total_amount,
            b.paid_amount,
            b.pending_amount,
            b.payment_status,
            b.payment_settlement_type,
            COALESCE(
                (SELECT bp.payment_mode FROM tbl_bill_payments bp WHERE bp.bill_id = b.id AND bp.status = 'SUCCESS' ORDER BY bp.id DESC LIMIT 1),
                NULL
            ) AS payment_mode,
            CASE
                WHEN b.appointment_id IS NULL THEN b.created_at
                ELSE COALESCE(c.doctor_finalized_at, c.created_at, a.actual_completed_at)
            END AS consultation_completed_at,
            b.status,
            b.remark,
            b.delivery_mode,
            b.delivery_details_json,
            b.created_at,
            b.updated_at,
            a.auid,
            COALESCE(a.appointment_date, DATE(b.created_at)) AS appointment_date,
            a.current_token_number AS token_number,
            s.slot_name,
            COALESCE(sto.override_start_time, s.start_time) AS start_time,
            COALESCE(sto.override_end_time, s.end_time) AS end_time,
            a.reception_status,
            a.consultation_payment_status,
            a.consultation_payment_settlement_type,
            COALESCE(fm.full_name, p.full_name) AS patient_full_name,
            p.mobile_no AS patient_mobile_no,
            a.booked_for_type,
            a.fk_patient_family_member_id,
            fm.relationship AS family_member_relationship,
            p.full_name AS primary_patient_full_name,
            br.branch_name,
            t.treatment_name
         FROM tbl_bills b
         LEFT JOIN tbl_appointments a ON a.appointment_id = b.appointment_id
         LEFT JOIN master_slots s ON s.id = a.fk_slot_id
         LEFT JOIN tbl_doctor_slot_time_overrides sto
           ON sto.fk_branch_id = a.fk_branch_id
          AND sto.fk_slot_id = a.fk_slot_id
          AND sto.appointment_date = a.appointment_date
          AND sto.status = 'ACTIVE'
         LEFT JOIN tbl_consultations c ON c.appointment_id = b.appointment_id
         LEFT JOIN master_users p ON p.id = COALESCE(a.fk_patient_id, b.patient_id)
         LEFT JOIN tbl_patient_family_members fm
           ON fm.id = a.fk_patient_family_member_id
         LEFT JOIN master_clinic_branches br ON br.id = b.fk_branch_id
         LEFT JOIN master_treatments t ON t.id = a.fk_treatment_id
         ${whereClause}
         ORDER BY 
            CASE
                WHEN b.appointment_id IS NULL THEN b.created_at
                ELSE COALESCE(c.doctor_finalized_at, c.created_at, a.actual_completed_at, b.created_at)
            END DESC,
            b.id DESC
         LIMIT ${pagination.pageSize} OFFSET ${pagination.offset}`,
        params
    );

    return res.status(200).json({
        success: true,
        message: 'Bills fetched successfully',
        data: rows.map((row) => decorateTokenFields(row)),
        meta: {
            ...buildPaginationMeta(pagination),
            total: pagination.total,
            filters: {
                type,
                payment_status: paymentStatus,
                payment_mode: paymentMode,
                from_date: fromDate,
                to_date: toDate,
                patient_search: patientSearch,
                branch_id: branchId,
                appointment_id: appointmentId,
                patient_id: req.user.role === 'patient' ? req.user.id : patientId,
            },
            role_scope: req.user.role,
        },
    });
});

const getBillById = asyncHandler(async (req, res) => {
    const billId = toPositiveInt(req.params.bill_id);

    if (!billId) {
        throw new AppError('Valid bill_id is required', 400);
    }

    const bill = await getBillDetailById(billId);

    if (!bill) {
        throw new AppError('Bill not found', 404);
    }

    if (req.user.role === 'patient' && Number(bill.patient_id) !== Number(req.user.id)) {
        throw new AppError('You are not authorized to access this bill', 403);
    }

    if (req.user.role === 'doctor') {
        const consultationScopeRows = await query(
            `SELECT c.id
             FROM tbl_consultations c
             WHERE c.appointment_id = ?
               AND c.doctor_id = ?
             LIMIT 1`,
            [bill.appointment_id, req.user.id]
        );

        if (consultationScopeRows.length === 0) {
            throw new AppError('You are not authorized to access this bill', 403);
        }
    }

    if (req.user.role === 'receptionist' && bill.bill_type !== 'CONSULTATION') {
        throw new AppError('Receptionist can only access consultation bills', 403);
    }

    if (req.user.role === 'medical' && bill.bill_type !== 'MEDICATION') {
        throw new AppError('Medical role can only access medication bills', 403);
    }

    return res.status(200).json({
        success: true,
        message: 'Bill fetched successfully',
        data: bill,
    });
});

const getAppointmentBillingSummary = asyncHandler(async (req, res) => {
    const appointmentId = toPositiveInt(req.params.appointment_id);

    if (!appointmentId) {
        throw new AppError('Valid appointment_id is required', 400);
    }

    const summary = await getAppointmentBillingSummaryByAppointmentId(appointmentId);

    if (!summary) {
        throw new AppError('No active bills found for this appointment', 404);
    }

    if (req.user.role === 'doctor' && Number(summary.doctor_id) !== Number(req.user.id)) {
        throw new AppError('You are not authorized to access this appointment billing summary', 403);
    }

    return res.status(200).json({
        success: true,
        message: 'Appointment billing summary fetched successfully',
        data: summary,
    });
});

module.exports = {
    createConsultationBill,
    collectConsultationPayment,
    createMedicationBill,
    listBills,
    getBillById,
    getAppointmentBillingSummary,
};
