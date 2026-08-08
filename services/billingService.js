const AppError = require('../utils/AppError');
const { query } = require('../config/db');
const { decorateTokenFields } = require('../utils/tokenDisplay');
const { getBillableDispensingItems } = require('./dispensaryPricingService');

const PAYMENT_MODES = new Set(['CASH', 'ONLINE']);
const PAYMENT_STATUSES = new Set(['UNPAID', 'PAID', 'PARTIAL']);
const PAYMENT_SETTLEMENT_TYPES = Object.freeze({
    COLLECTED: 'COLLECTED',
    FOLLOW_UP: 'FOLLOW_UP',
});

const normalizeAmount = (value) => {
    const parsed = Number(value);

    if (!Number.isFinite(parsed) || parsed < 0) {
        return null;
    }

    return Number(parsed.toFixed(2));
};

const formatDateForId = (date = new Date()) => {
    const day = String(date.getDate()).padStart(2, '0');
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const year = String(date.getFullYear());

    return `${day}${month}${year}`;
};

const generateBillNumber = async (connection, date = new Date()) => {
    const datePart = formatDateForId(date);
    const prefix = `BILL${datePart}`;
    const lockName = `bill_number_${datePart}`;

    const [lockRows] = await connection.execute('SELECT GET_LOCK(?, 10) AS acquired_lock', [lockName]);

    if (!lockRows[0]?.acquired_lock) {
        throw new AppError('Unable to generate bill number right now. Please try again.', 503);
    }

    try {
        const [existingRows] = await connection.execute(
            `SELECT bill_number
             FROM tbl_bills
             WHERE bill_number LIKE ?
             ORDER BY bill_number DESC
             LIMIT 1`,
            [`${prefix}%`]
        );

        const lastBillNumber = existingRows[0]?.bill_number || null;
        const lastSerial = lastBillNumber ? Number(String(lastBillNumber).slice(prefix.length)) : 0;
        const nextSerial = lastSerial + 1;

        if (nextSerial > 9999) {
            throw new AppError('Daily bill number generation limit exceeded', 409);
        }

        return `${prefix}${String(nextSerial).padStart(4, '0')}`;
    } finally {
        await connection.execute('DO RELEASE_LOCK(?)', [lockName]);
    }
};

const ensureValidPaymentMode = (paymentMode) => {
    const normalized = String(paymentMode || '').trim().toUpperCase();

    if (!PAYMENT_MODES.has(normalized)) {
        throw new AppError('payment_mode must be CASH or ONLINE', 400);
    }

    return normalized;
};

const ensureValidPaymentSettlementType = (paymentSettlementType) => {
    const normalized = String(paymentSettlementType || '').trim().toUpperCase();

    if (!Object.values(PAYMENT_SETTLEMENT_TYPES).includes(normalized)) {
        throw new AppError('payment_settlement_type must be COLLECTED or FOLLOW_UP', 400);
    }

    return normalized;
};

const buildBillLabel = (billType) => {
    if (billType === 'CONSULTATION') {
        return 'Consultation';
    }

    if (billType === 'MEDICATION') {
        return 'Medication';
    }

    return 'Bill';
};

const replaceMedicationBillItems = async ({
    connection,
    billId,
    pricingId,
    consultationId,
}) => {
    await connection.execute(
        `DELETE FROM tbl_bill_items
         WHERE bill_id = ?`,
        [billId]
    );

    const [pricingItems] = await connection.execute(
        `SELECT
            mpi.consultation_medication_id,
            mpi.medicine_value,
            mpi.amount,
            cm.added_by_role
         FROM tbl_medical_prescription_pricing_items mpi
         LEFT JOIN tbl_consultation_medications cm ON cm.id = mpi.consultation_medication_id
         WHERE mpi.pricing_id = ?
           AND mpi.dispense_status = 'ACTIVE'
         ORDER BY mpi.id ASC`,
        [pricingId]
    );

    for (const item of getBillableDispensingItems(pricingItems)) {
        const itemAmount = normalizeAmount(item.amount) ?? 0;
        const itemType = String(item.added_by_role || '').trim().toUpperCase() === 'MEDICAL'
            ? 'ADDITIONAL_MEDICATION'
            : 'MEDICATION';

        await connection.execute(
            `INSERT INTO tbl_bill_items
             (bill_id, consultation_medication_id, consultation_test_id, item_type, item_name, quantity, unit_price, amount)
             VALUES (?, ?, NULL, ?, ?, 1, ?, ?)`,
            [billId, item.consultation_medication_id, itemType, item.medicine_value, itemAmount, itemAmount]
        );
    }

    const [consultationTests] = await connection.execute(
        `SELECT
            id AS consultation_test_id,
            test_name,
            amount
         FROM tbl_consultation_tests
         WHERE consultation_id = ?
         ORDER BY id ASC`,
        [consultationId]
    );

    for (const test of consultationTests) {
        const testAmount = normalizeAmount(test.amount) ?? 0;
        await connection.execute(
            `INSERT INTO tbl_bill_items
             (bill_id, consultation_medication_id, consultation_test_id, item_type, item_name, quantity, unit_price, amount)
             VALUES (?, NULL, ?, 'TEST', ?, 1, ?, ?)`,
            [billId, test.consultation_test_id, test.test_name, testAmount, testAmount]
        );
    }
};

const collectBillPayment = async ({
    connection,
    billId,
    appointmentId = null,
    consultationId = null,
    amount,
    paymentMode,
    transactionReference = null,
    remark = null,
    collectedByUserId,
    collectedByRole,
    expectedBillType,
    paymentFor,
}) => {
    const normalizedMode = ensureValidPaymentMode(paymentMode);
    const normalizedTransactionReference = transactionReference ? String(transactionReference).trim() : null;
    const normalizedAmount = normalizeAmount(amount);

    if (normalizedAmount === null) {
        throw new AppError('amount must be a valid non-negative number', 400);
    }

    if (normalizedMode === 'ONLINE' && !normalizedTransactionReference) {
        throw new AppError('transaction_reference is required when payment_mode is ONLINE', 400);
    }

    const params = [billId];
    const conditions = ['b.id = ?'];

    if (appointmentId) {
        conditions.push('b.appointment_id = ?');
        params.push(appointmentId);
    }

    if (consultationId) {
        conditions.push('b.consultation_id = ?');
        params.push(consultationId);
    }

    const [rows] = await connection.execute(
        `SELECT
            b.id,
            b.bill_type,
            b.appointment_id,
            b.consultation_id,
            b.patient_id,
            b.total_amount,
            b.paid_amount,
            b.pending_amount,
            b.payment_status,
            b.status,
            a.reception_status,
            a.consultation_payment_status
         FROM tbl_bills b
         LEFT JOIN tbl_appointments a ON a.appointment_id = b.appointment_id
         WHERE ${conditions.join(' AND ')}
         LIMIT 1
         FOR UPDATE`,
        params
    );

    const billLabel = buildBillLabel(expectedBillType);

    if (rows.length === 0) {
        throw new AppError(`${billLabel} bill not found`, 404);
    }

    const bill = rows[0];

    if (expectedBillType && bill.bill_type !== expectedBillType) {
        throw new AppError(`Only ${billLabel.toLowerCase()} bills can be collected with this endpoint`, 400);
    }

    if (bill.status !== 'ACTIVE') {
        throw new AppError('Only active bills can be collected', 409);
    }

    if (bill.payment_status === 'PAID') {
        throw new AppError(`${billLabel} bill is already paid`, 409);
    }

    if (expectedBillType === 'CONSULTATION' && bill.consultation_payment_status === 'PAID') {
        throw new AppError('Consultation bill is already paid', 409);
    }

    const existingTotalAmount = normalizeAmount(bill.total_amount) ?? 0;
    const paidAmount = normalizeAmount(bill.paid_amount) ?? 0;
    const totalAmount = existingTotalAmount > 0 ? existingTotalAmount : normalizedAmount;
    const dueAmount = normalizeAmount(totalAmount - paidAmount) ?? 0;

    if (normalizedAmount <= 0) {
        throw new AppError('amount must be greater than 0', 400);
    }

    if (normalizedAmount > dueAmount) {
        throw new AppError('amount cannot be greater than pending amount', 400);
    }

    const nextPaidAmount = normalizeAmount(paidAmount + normalizedAmount) ?? paidAmount;
    const nextPendingAmount = normalizeAmount(totalAmount - nextPaidAmount) ?? 0;
    const nextPaymentStatus = nextPendingAmount <= 0 ? 'PAID' : 'PARTIAL';

    await connection.execute(
        `INSERT INTO tbl_bill_payments
         (bill_id, appointment_id, consultation_id, patient_id, payment_for, amount, payment_mode, transaction_reference, remark, collected_by_user_id, collected_by_role, collected_at, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), 'SUCCESS')`,
        [
            bill.id,
            bill.appointment_id,
            bill.consultation_id,
            bill.patient_id,
            paymentFor,
            normalizedAmount,
            normalizedMode,
            normalizedTransactionReference,
            remark,
            collectedByUserId,
            collectedByRole,
        ]
    );

    await connection.execute(
        `UPDATE tbl_bills
         SET total_amount = ?,
             paid_amount = ?,
             pending_amount = ?,
             payment_status = ?,
             updated_by = ?
         WHERE id = ?`,
        [totalAmount, nextPaidAmount, nextPendingAmount, nextPaymentStatus, collectedByUserId, bill.id]
    );

    if (expectedBillType === 'CONSULTATION') {
        await connection.execute(
            `UPDATE tbl_appointments
             SET consultation_payment_status = ?,
                 payment_collected_at = CASE WHEN ? = 'PAID' THEN NOW() ELSE payment_collected_at END,
                 payment_collected_by = ?,
                 updated_by = ?
             WHERE appointment_id = ?`,
            [nextPaymentStatus === 'PAID' ? 'PAID' : 'UNPAID', nextPaymentStatus, collectedByUserId, collectedByUserId, bill.appointment_id]
        );
    }

    return {
        billId: bill.id,
        appointmentId: bill.appointment_id,
        consultationId: bill.consultation_id,
        paymentStatus: nextPaymentStatus,
    };
};

const getBillSummaryById = async (billId) => {
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
            b.status,
            b.remark,
            b.created_at,
            b.updated_at,
            a.auid,
            a.appointment_date,
            a.current_token_number AS token_number,
            s.slot_name,
            COALESCE(sto.override_start_time, s.start_time) AS start_time,
            COALESCE(sto.override_end_time, s.end_time) AS end_time,
            t.treatment_name,
            COALESCE(fm.full_name, p.full_name) AS patient_full_name,
            p.mobile_no AS patient_mobile_no,
            a.booked_for_type,
            a.fk_patient_family_member_id,
            fm.relationship AS family_member_relationship,
            p.full_name AS primary_patient_full_name,
            br.branch_name
         FROM tbl_bills b
         LEFT JOIN tbl_appointments a ON a.appointment_id = b.appointment_id
         LEFT JOIN master_slots s ON s.id = a.fk_slot_id
         LEFT JOIN tbl_doctor_slot_time_overrides sto
           ON sto.fk_branch_id = a.fk_branch_id
          AND sto.fk_slot_id = a.fk_slot_id
          AND sto.appointment_date = a.appointment_date
          AND sto.status = 'ACTIVE'
         LEFT JOIN master_treatments t ON t.id = a.fk_treatment_id
         LEFT JOIN master_users p ON p.id = a.fk_patient_id
         LEFT JOIN tbl_patient_family_members fm
           ON fm.id = a.fk_patient_family_member_id
         LEFT JOIN master_clinic_branches br ON br.id = b.fk_branch_id
         WHERE b.id = ?
         LIMIT 1`,
        [billId]
    );
    return decorateTokenFields(rows[0] || null);
};

const getBillDetailById = async (billId) => {
    const summary = await getBillSummaryById(billId);

    if (!summary) {
        return null;
    }

    const [payments, items] = await Promise.all([
        query(
            `SELECT
                id AS payment_id,
                bill_id,
                appointment_id,
                consultation_id,
                patient_id,
                payment_for,
                amount,
                payment_mode,
                transaction_reference,
                remark,
                collected_by_user_id,
                collected_by_role,
                collected_at,
                status,
                created_at
             FROM tbl_bill_payments
             WHERE bill_id = ?
             ORDER BY id ASC`,
            [billId]
        ),
        query(
            `SELECT
                id AS bill_item_id,
                bill_id,
                consultation_medication_id,
                consultation_test_id,
                item_type,
                item_name,
                quantity,
                unit_price,
                amount,
                created_at
             FROM tbl_bill_items
             WHERE bill_id = ?
             ORDER BY id ASC`,
            [billId]
        ),
    ]);

    return {
        ...summary,
        payments,
        items,
    };
};

const getAppointmentBillingSummaryByAppointmentId = async (appointmentId) => {
    const billRows = await query(
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
            b.status,
            b.remark,
            b.created_at,
            b.updated_at,
            a.auid,
            a.appointment_date,
            a.current_token_number AS token_number,
            s.slot_name,
            COALESCE(sto.override_start_time, s.start_time) AS start_time,
            COALESCE(sto.override_end_time, s.end_time) AS end_time,
            a.status AS appointment_status,
            COALESCE(fm.full_name, p.full_name) AS patient_full_name,
            p.mobile_no AS patient_mobile_no,
            p.uuid AS patient_uuid,
            a.booked_for_type,
            a.fk_patient_family_member_id,
            fm.relationship AS family_member_relationship,
            p.full_name AS primary_patient_full_name,
            br.branch_name,
            t.treatment_name,
            c.doctor_id
         FROM tbl_bills b
         JOIN tbl_appointments a ON a.appointment_id = b.appointment_id
         LEFT JOIN master_slots s ON s.id = a.fk_slot_id
         LEFT JOIN tbl_doctor_slot_time_overrides sto
           ON sto.fk_branch_id = a.fk_branch_id
          AND sto.fk_slot_id = a.fk_slot_id
          AND sto.appointment_date = a.appointment_date
          AND sto.status = 'ACTIVE'
         LEFT JOIN tbl_consultations c ON c.appointment_id = a.appointment_id
         LEFT JOIN master_users p ON p.id = a.fk_patient_id
         LEFT JOIN tbl_patient_family_members fm
           ON fm.id = a.fk_patient_family_member_id
         LEFT JOIN master_clinic_branches br ON br.id = b.fk_branch_id
         LEFT JOIN master_treatments t ON t.id = a.fk_treatment_id
         WHERE b.appointment_id = ?
           AND b.status = 'ACTIVE'
         ORDER BY b.created_at ASC, b.id ASC`,
        [appointmentId]
    );

    if (billRows.length === 0) {
        return null;
    }

    const bills = await Promise.all(billRows.map((row) => getBillDetailById(row.bill_id)));
    const validBills = bills.filter(Boolean);
    const firstRow = billRows[0];

    const mergedPayments = validBills
        .flatMap((bill) => (bill.payments || []).map((payment) => ({
            ...payment,
            bill_id: bill.bill_id,
            bill_number: bill.bill_number,
            bill_type: bill.bill_type,
        })))
        .sort((a, b) => new Date(a.collected_at || a.created_at || 0).getTime() - new Date(b.collected_at || b.created_at || 0).getTime());

    const grandTotal = validBills.reduce((sum, bill) => sum + (Number(bill.total_amount) || 0), 0);
    const grandPaid = validBills.reduce((sum, bill) => sum + (Number(bill.paid_amount) || 0), 0);
    const grandPending = validBills.reduce((sum, bill) => sum + (Number(bill.pending_amount) || 0), 0);
    const overallPaymentStatus = validBills.length > 0 && validBills.every((bill) => bill.payment_status === 'PAID')
        ? 'PAID'
        : grandPending <= 0 && grandTotal > 0
        ? 'PAID'
        : grandPaid > 0
            ? 'PARTIAL'
            : 'UNPAID';

    return {
        appointment: {
            appointment_id: firstRow.appointment_id,
            auid: firstRow.auid,
            appointment_date: firstRow.appointment_date,
            ...decorateTokenFields({
                slot_name: firstRow.slot_name,
                start_time: firstRow.start_time,
                token_number: firstRow.token_number,
            }),
            status: firstRow.appointment_status,
            patient_id: firstRow.patient_id,
            patient_uuid: firstRow.patient_uuid,
            patient_full_name: firstRow.patient_full_name,
            patient_mobile_no: firstRow.patient_mobile_no,
            booked_for_type: firstRow.booked_for_type,
            fk_patient_family_member_id: firstRow.fk_patient_family_member_id,
            family_member_relationship: firstRow.family_member_relationship,
            primary_patient_full_name: firstRow.primary_patient_full_name,
            branch_id: firstRow.branch_id,
            branch_name: firstRow.branch_name,
            treatment_name: firstRow.treatment_name,
        },
        doctor_id: firstRow.doctor_id || null,
        bills: validBills,
        payments: mergedPayments,
        summary: {
            grand_total: Number(grandTotal.toFixed(2)),
            grand_paid: Number(grandPaid.toFixed(2)),
            grand_pending: Number(grandPending.toFixed(2)),
            overall_payment_status: overallPaymentStatus,
        },
    };
};

const createConsultationBillForAppointment = async ({
    connection,
    appointmentId,
    patientId,
    branchId,
    treatmentId,
    paymentSettlementType = PAYMENT_SETTLEMENT_TYPES.COLLECTED,
    actorUserId = null,
    remark = null,
}) => {
    const normalizedPaymentSettlementType = ensureValidPaymentSettlementType(paymentSettlementType);
    const [existingRows] = await connection.execute(
        `SELECT id
         FROM tbl_bills
         WHERE bill_type = 'CONSULTATION'
           AND appointment_id = ?
           AND status = 'ACTIVE'
         LIMIT 1`,
        [appointmentId]
    );

    if (existingRows.length > 0) {
        return {
            billId: existingRows[0].id,
            created: false,
        };
    }

    const [treatmentRows] = await connection.execute(
        `SELECT id, consultation_fee
         FROM master_treatments
         WHERE id = ?
           AND is_active = 1
         LIMIT 1`,
        [treatmentId]
    );

    if (treatmentRows.length === 0) {
        throw new AppError('Selected treatment not found or inactive', 404);
    }

    const isFollowUpSettlement = normalizedPaymentSettlementType === PAYMENT_SETTLEMENT_TYPES.FOLLOW_UP;
    const totalAmount = isFollowUpSettlement
        ? 0
        : (normalizeAmount(treatmentRows[0].consultation_fee ?? 0) ?? 0);
    const paidAmount = 0;
    const pendingAmount = isFollowUpSettlement ? 0 : totalAmount;
    const paymentStatus = isFollowUpSettlement ? 'PAID' : 'UNPAID';
    const billNumber = await generateBillNumber(connection);

    const [insertResult] = await connection.execute(
        `INSERT INTO tbl_bills
         (bill_number, bill_type, appointment_id, consultation_id, patient_id, fk_branch_id, total_amount, paid_amount, pending_amount, payment_status, payment_settlement_type, status, remark, created_by, updated_by)
         VALUES (?, 'CONSULTATION', ?, NULL, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?, ?)`,
        [
            billNumber,
            appointmentId,
            patientId,
            branchId,
            totalAmount,
            paidAmount,
            pendingAmount,
            paymentStatus,
            normalizedPaymentSettlementType,
            remark,
            actorUserId,
            actorUserId,
        ]
    );

    await connection.execute(
        `UPDATE tbl_appointments
         SET consultation_bill_id = ?,
             consultation_payment_status = ?,
             consultation_payment_settlement_type = ?,
             updated_by = COALESCE(?, updated_by)
         WHERE appointment_id = ?`,
        [insertResult.insertId, paymentStatus, normalizedPaymentSettlementType, actorUserId, appointmentId]
    );

    return {
        billId: insertResult.insertId,
        created: true,
    };
};

const transferConsultationBillToAppointment = async ({
    connection,
    oldAppointmentId,
    newAppointmentId,
    billId,
    paymentStatus = 'UNPAID',
    paymentSettlementType = PAYMENT_SETTLEMENT_TYPES.COLLECTED,
    actorUserId = null,
}) => {
    const normalizedPaymentStatus = PAYMENT_STATUSES.has(String(paymentStatus || '').trim().toUpperCase())
        ? String(paymentStatus || '').trim().toUpperCase()
        : 'UNPAID';
    const normalizedPaymentSettlementType = ensureValidPaymentSettlementType(paymentSettlementType);

    await connection.execute(
        `UPDATE tbl_bills
         SET appointment_id = ?,
             payment_settlement_type = ?,
             updated_by = COALESCE(?, updated_by)
         WHERE id = ?
           AND bill_type = 'CONSULTATION'`,
        [newAppointmentId, normalizedPaymentSettlementType, actorUserId, billId]
    );

    await connection.execute(
        `UPDATE tbl_appointments
         SET consultation_bill_id = NULL,
             consultation_payment_status = 'UNPAID',
             consultation_payment_settlement_type = ?,
             updated_by = COALESCE(?, updated_by)
         WHERE appointment_id = ?`,
        [PAYMENT_SETTLEMENT_TYPES.COLLECTED, actorUserId, oldAppointmentId]
    );

    await connection.execute(
        `UPDATE tbl_appointments
         SET consultation_bill_id = ?,
             consultation_payment_status = ?,
             consultation_payment_settlement_type = ?,
             updated_by = COALESCE(?, updated_by)
         WHERE appointment_id = ?`,
        [billId, normalizedPaymentStatus, normalizedPaymentSettlementType, actorUserId, newAppointmentId]
    );
};

const collectConsultationBillPayment = async ({
    connection,
    billId,
    appointmentId = null,
    amount,
    paymentMode,
    transactionReference = null,
    remark = null,
    collectedByUserId,
    collectedByRole,
}) => {
    return collectBillPayment({
        connection,
        billId,
        appointmentId,
        amount,
        paymentMode,
        transactionReference,
        remark,
        collectedByUserId,
        collectedByRole,
        expectedBillType: 'CONSULTATION',
        paymentFor: 'CONSULTATION',
    });
};

const collectMedicationBillPayment = async ({
    connection,
    billId,
    consultationId = null,
    amount,
    paymentMode,
    transactionReference = null,
    remark = null,
    collectedByUserId,
    collectedByRole,
}) => {
    return collectBillPayment({
        connection,
        billId,
        consultationId,
        amount,
        paymentMode,
        transactionReference,
        remark,
        collectedByUserId,
        collectedByRole,
        expectedBillType: 'MEDICATION',
        paymentFor: 'MEDICATION',
    });
};

const createMedicationBillFromConsultation = async ({
    connection,
    consultationId,
    createdByUserId,
    remark = null,
}) => {
    const [existingRows] = await connection.execute(
        `SELECT id, payment_status, paid_amount
         FROM tbl_bills
         WHERE bill_type = 'MEDICATION'
           AND consultation_id = ?
           AND status = 'ACTIVE'
         LIMIT 1`,
        [consultationId]
    );

    const [consultationRows] = await connection.execute(
        `SELECT
            c.id AS consultation_id,
            c.appointment_id,
            a.fk_patient_id AS patient_id,
            a.fk_branch_id AS branch_id,
            mpp.id AS pricing_id,
            mpp.total_amount,
            COALESCE(mpp.remark, '') AS pricing_remark
         FROM tbl_consultations c
         JOIN tbl_appointments a ON a.appointment_id = c.appointment_id
         JOIN tbl_medical_prescription_pricing mpp ON mpp.consultation_id = c.id
         WHERE c.id = ?
         LIMIT 1
         FOR UPDATE`,
        [consultationId]
    );

    if (consultationRows.length === 0) {
        throw new AppError('Medical pricing not found for this consultation', 404);
    }

    const consultation = consultationRows[0];
    const totalAmount = normalizeAmount(consultation.total_amount) ?? 0;
    const billRemark = remark || consultation.pricing_remark || null;

    if (existingRows.length > 0) {
        const existingBill = existingRows[0];
        const paidAmount = normalizeAmount(existingBill.paid_amount) ?? 0;

        if (existingBill.payment_status === 'PAID' || paidAmount > 0) {
            throw new AppError('Medication bill already has collected payment and cannot be updated', 409);
        }

        await connection.execute(
            `UPDATE tbl_bills
             SET total_amount = ?,
                 paid_amount = 0,
                 pending_amount = ?,
                 payment_status = 'UNPAID',
                 remark = ?,
                 updated_by = ?
             WHERE id = ?`,
            [totalAmount, totalAmount, billRemark, createdByUserId, existingBill.id]
        );

        await replaceMedicationBillItems({
            connection,
            billId: existingBill.id,
            pricingId: consultation.pricing_id,
            consultationId,
        });

        return {
            billId: existingBill.id,
            created: false,
        };
    }

    const billNumber = await generateBillNumber(connection);

    const [insertResult] = await connection.execute(
        `INSERT INTO tbl_bills
         (bill_number, bill_type, appointment_id, consultation_id, patient_id, fk_branch_id, total_amount, paid_amount, pending_amount, payment_status, status, remark, created_by, updated_by)
         VALUES (?, 'MEDICATION', ?, ?, ?, ?, ?, 0, ?, 'UNPAID', 'ACTIVE', ?, ?, ?)`,
        [
            billNumber,
            consultation.appointment_id,
            consultation.consultation_id,
            consultation.patient_id,
            consultation.branch_id,
            totalAmount,
            totalAmount,
            billRemark,
            createdByUserId,
            createdByUserId,
        ]
    );

    await replaceMedicationBillItems({
        connection,
        billId: insertResult.insertId,
        pricingId: consultation.pricing_id,
        consultationId,
    });

    return {
        billId: insertResult.insertId,
        created: true,
    };
};

module.exports = {
    PAYMENT_MODES,
    PAYMENT_SETTLEMENT_TYPES,
    createConsultationBillForAppointment,
    transferConsultationBillToAppointment,
    collectConsultationBillPayment,
    collectMedicationBillPayment,
    createMedicationBillFromConsultation,
    getBillSummaryById,
    getBillDetailById,
    getAppointmentBillingSummaryByAppointmentId,
    normalizeAmount,
};
