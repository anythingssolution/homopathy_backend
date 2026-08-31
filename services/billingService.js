const AppError = require('../utils/AppError');
const { query } = require('../config/db');
const { decorateTokenFields } = require('../utils/tokenDisplay');
const { getBillableDispensingItems } = require('./dispensaryPricingService');

const PAYMENT_MODES = new Set(['CASH', 'ONLINE']);
const PAYMENT_STATUSES = new Set(['UNPAID', 'PAID', 'PARTIAL']);
const ALLOCATION_KINDS = Object.freeze({
    CURRENT: 'CURRENT',
    PREVIOUS: 'PREVIOUS',
});
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
           AND COALESCE(dispense_status, 'ACTIVE') = 'ACTIVE'
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

const ensureValidAllocationKind = (allocationKind) => {
    const normalized = String(allocationKind || ALLOCATION_KINDS.CURRENT).trim().toUpperCase();

    if (!Object.values(ALLOCATION_KINDS).includes(normalized)) {
        throw new AppError('allocation_kind must be CURRENT or PREVIOUS', 400);
    }

    return normalized;
};

const resolveSettlementSourceBillId = (settlementSourceBillId, fallbackBillId) => {
    if (settlementSourceBillId === null) {
        return null;
    }

    const parsed = Number(settlementSourceBillId === undefined ? fallbackBillId : settlementSourceBillId);

    if (!Number.isInteger(parsed) || parsed <= 0) {
        return fallbackBillId || null;
    }

    return parsed;
};

const toPaymentSummary = (cashAmount = 0, onlineAmount = 0) => {
    const cash = Number((Number(cashAmount || 0)).toFixed(2));
    const online = Number((Number(onlineAmount || 0)).toFixed(2));
    return {
        cash_amount: cash,
        online_amount: online,
        payment_mode: cash > 0 && online > 0 ? 'MIXED' : online > 0 ? 'ONLINE' : cash > 0 ? 'CASH' : null,
    };
};

const getMedicationPaymentSummaries = async ({ consultationIds = [], billIds = [] } = {}) => {
    const byConsultationId = new Map();
    const byBillId = new Map();
    const normalizedConsultationIds = [...new Set((consultationIds || []).map(Number).filter((id) => Number.isInteger(id) && id > 0))];
    const normalizedBillIds = [...new Set((billIds || []).map(Number).filter((id) => Number.isInteger(id) && id > 0))];
    const conditions = [];
    const params = [];

    if (normalizedConsultationIds.length > 0) {
        conditions.push(`(b.consultation_id IN (${normalizedConsultationIds.map(() => '?').join(',')}) AND b.bill_type = 'MEDICATION' AND b.status = 'ACTIVE')`);
        params.push(...normalizedConsultationIds);
    }
    if (normalizedBillIds.length > 0) {
        conditions.push(`b.id IN (${normalizedBillIds.map(() => '?').join(',')})`);
        params.push(...normalizedBillIds);
    }
    if (conditions.length === 0) {
        return { byConsultationId, byBillId };
    }

    const rows = await query(
        `SELECT
            b.id AS bill_id,
            b.consultation_id,
            COALESCE(SUM(CASE WHEN UPPER(bp.payment_mode) = 'CASH' THEN bp.amount ELSE 0 END), 0) AS cash_amount,
            COALESCE(SUM(CASE WHEN UPPER(bp.payment_mode) = 'ONLINE' THEN bp.amount ELSE 0 END), 0) AS online_amount
         FROM tbl_bills b
         LEFT JOIN tbl_bill_payments bp
           ON bp.status = 'SUCCESS'
          AND (
            bp.settlement_source_bill_id = b.id
            OR (bp.settlement_source_bill_id IS NULL AND bp.bill_id = b.id)
          )
         WHERE ${conditions.join(' OR ')}
         GROUP BY b.id, b.consultation_id`,
        params
    );

    rows.forEach((row) => {
        const summary = toPaymentSummary(row.cash_amount, row.online_amount);
        if (row.bill_id) {
            byBillId.set(Number(row.bill_id), summary);
        }
        if (row.consultation_id) {
            const existing = byConsultationId.get(Number(row.consultation_id)) || toPaymentSummary(0, 0);
            byConsultationId.set(Number(row.consultation_id), toPaymentSummary(
                existing.cash_amount + summary.cash_amount,
                existing.online_amount + summary.online_amount
            ));
        }
    });

    return { byConsultationId, byBillId };
};

const mapBillPaymentRow = (row) => ({
    payment_id: Number(row.payment_id),
    bill_id: Number(row.bill_id),
    bill_number: row.bill_number || null,
    bill_type: row.bill_type || null,
    appointment_id: row.appointment_id ? Number(row.appointment_id) : null,
    consultation_id: row.consultation_id ? Number(row.consultation_id) : null,
    patient_id: row.patient_id ? Number(row.patient_id) : null,
    payment_for: row.payment_for,
    allocation_kind: String(row.allocation_kind || ALLOCATION_KINDS.CURRENT).toUpperCase(),
    settlement_source_bill_id: row.settlement_source_bill_id ? Number(row.settlement_source_bill_id) : null,
    settlement_source_bill_number: row.settlement_source_bill_number || null,
    amount: normalizeAmount(row.amount) ?? 0,
    pending_before: row.pending_before == null ? null : (normalizeAmount(row.pending_before) ?? 0),
    pending_after: row.pending_after == null ? null : (normalizeAmount(row.pending_after) ?? 0),
    collection_total_amount: row.collection_total_amount == null ? null : (normalizeAmount(row.collection_total_amount) ?? 0),
    payment_mode: row.payment_mode,
    transaction_reference: row.transaction_reference || null,
    remark: row.remark || null,
    collected_by_user_id: row.collected_by_user_id ? Number(row.collected_by_user_id) : null,
    collected_by_role: row.collected_by_role || null,
    collected_at: row.collected_at,
    status: row.status,
    created_at: row.created_at,
});

const billPaymentSelectSql = `
    bp.id AS payment_id,
    bp.bill_id,
    b.bill_number,
    b.bill_type,
    bp.appointment_id,
    bp.consultation_id,
    bp.patient_id,
    bp.payment_for,
    bp.allocation_kind,
    bp.settlement_source_bill_id,
    src.bill_number AS settlement_source_bill_number,
    bp.amount,
    bp.pending_before,
    bp.pending_after,
    (
        SELECT COALESCE(SUM(sibling.amount), bp.amount)
        FROM tbl_bill_payments sibling
        WHERE sibling.status = 'SUCCESS'
          AND UPPER(sibling.payment_mode) = UPPER(bp.payment_mode)
          AND sibling.collected_at = bp.collected_at
          AND (
            (
                bp.settlement_source_bill_id IS NOT NULL
                AND sibling.settlement_source_bill_id = bp.settlement_source_bill_id
            )
            OR (
                bp.settlement_source_bill_id IS NULL
                AND sibling.bill_id = bp.bill_id
            )
          )
    ) AS collection_total_amount,
    bp.payment_mode,
    bp.transaction_reference,
    bp.remark,
    bp.collected_by_user_id,
    bp.collected_by_role,
    bp.collected_at,
    bp.status,
    bp.created_at
`;

const billPaymentFromSql = `
    FROM tbl_bill_payments bp
    JOIN tbl_bills b ON b.id = bp.bill_id
    LEFT JOIN tbl_bills src ON src.id = bp.settlement_source_bill_id
`;

const sumPaymentAmounts = (payments = []) => Number(payments.reduce((sum, payment) => (
    sum + Number(payment.amount || 0)
), 0).toFixed(2));

const sumPaymentAmountsByMode = (payments = [], mode) => Number(payments.reduce((sum, payment) => (
    String(payment.payment_mode || '').toUpperCase() === mode
        ? sum + Number(payment.amount || 0)
        : sum
), 0).toFixed(2));

const summarizePreviousPendingSettlements = (payments = []) => {
    const byBillId = new Map();

    payments
        .filter((payment) => String(payment.status || '').toUpperCase() === 'SUCCESS')
        .forEach((payment) => {
            const billId = Number(payment.bill_id);
            if (!Number.isInteger(billId) || billId <= 0) {
                return;
            }

            const current = byBillId.get(billId) || {
                bill_id: billId,
                bill_number: payment.bill_number || null,
                paid_amount: 0,
                pending_before: payment.pending_before == null ? null : Number(payment.pending_before || 0),
                pending_after: payment.pending_after == null ? null : Number(payment.pending_after || 0),
                last_received_at: getPaymentEventTimeValue(payment),
                payment_mode: payment.payment_mode || null,
            };

            const eventTime = getPaymentEventTimeValue(payment);
            const currentTime = current.last_received_at ? new Date(current.last_received_at).getTime() : 0;
            const nextTime = eventTime ? new Date(eventTime).getTime() : 0;

            current.paid_amount = Number((Number(current.paid_amount || 0) + Number(payment.amount || 0)).toFixed(2));

            if (!current.last_received_at || nextTime >= currentTime) {
                current.pending_after = payment.pending_after == null ? current.pending_after : Number(payment.pending_after || 0);
                current.last_received_at = eventTime;
                current.payment_mode = payment.payment_mode || current.payment_mode;
            }

            byBillId.set(billId, current);
        });

    return Array.from(byBillId.values()).map((item) => ({
        ...item,
        paid_amount: Number(Number(item.paid_amount || 0).toFixed(2)),
        pending_before: item.pending_before == null ? null : Number(Number(item.pending_before || 0).toFixed(2)),
        pending_after: item.pending_after == null ? null : Number(Number(item.pending_after || 0).toFixed(2)),
    }));
};

const getPaymentEventTimeValue = (payment) => payment?.collected_at || payment?.created_at || null;

const getPaymentEventKeyValue = (payment) => {
    const eventTime = getPaymentEventTimeValue(payment);
    if (!eventTime) {
        return '';
    }

    const parsedTime = new Date(eventTime).getTime();
    const normalizedTime = Number.isNaN(parsedTime) ? String(eventTime) : String(parsedTime);
    return `${normalizedTime}|${String(payment.payment_mode || '').toUpperCase()}`;
};

const buildBillPaymentBreakdown = ({ summary, payments = [], previousPendingSettlements = [] }) => {
    const successfulPayments = payments.filter((payment) => String(payment.status || '').toUpperCase() === 'SUCCESS');
    const directBillPayments = successfulPayments.filter((payment) => String(payment.allocation_kind || ALLOCATION_KINDS.CURRENT).toUpperCase() !== ALLOCATION_KINDS.PREVIOUS);
    const laterPendingReceipts = successfulPayments.filter((payment) => String(payment.allocation_kind || '').toUpperCase() === ALLOCATION_KINDS.PREVIOUS);
    const successfulPreviousSettlements = previousPendingSettlements.filter((payment) => String(payment.status || '').toUpperCase() === 'SUCCESS');
    const timelineRows = [...directBillPayments, ...laterPendingReceipts, ...successfulPreviousSettlements];
    const lastPayment = timelineRows
        .filter((payment) => getPaymentEventTimeValue(payment))
        .sort((a, b) => new Date(getPaymentEventTimeValue(b)).getTime() - new Date(getPaymentEventTimeValue(a)).getTime())[0] || null;
    const lastPaymentKey = getPaymentEventKeyValue(lastPayment);
    const groupedLastReceivedAmount = lastPaymentKey
        ? timelineRows
            .filter((payment) => getPaymentEventKeyValue(payment) === lastPaymentKey)
            .reduce((sum, payment) => sum + Number(payment.amount || 0), 0)
        : 0;

    const receivedAtBilling = sumPaymentAmounts(directBillPayments);
    const laterPendingReceived = sumPaymentAmounts(laterPendingReceipts);
    const previousPendingPaid = sumPaymentAmounts(successfulPreviousSettlements);
    const previousPendingSettlementSummary = summarizePreviousPendingSettlements(successfulPreviousSettlements);
    const previousPendingRemaining = previousPendingSettlementSummary.reduce((sum, settlement) => (
        sum + Number(settlement.pending_after || 0)
    ), 0);
    const totalPaid = Number(summary?.paid_amount || 0);
    const pendingAmount = Number(summary?.pending_amount || 0);

    return {
        current_bill_total: Number(summary?.total_amount || 0),
        received_at_billing: receivedAtBilling,
        later_pending_received: laterPendingReceived,
        previous_pending_paid: previousPendingPaid,
        total_paid: Number(totalPaid.toFixed(2)),
        pending_amount: Number(pendingAmount.toFixed(2)),
        payment_status: summary?.payment_status || (pendingAmount <= 0 ? 'PAID' : totalPaid > 0 ? 'PARTIAL' : 'UNPAID'),
        previous_pending_remaining: Number(previousPendingRemaining.toFixed(2)),
        previous_pending_settlements_summary: previousPendingSettlementSummary,
        cash_received_at_billing: sumPaymentAmountsByMode(directBillPayments, 'CASH'),
        online_received_at_billing: sumPaymentAmountsByMode(directBillPayments, 'ONLINE'),
        cash_later_pending_received: sumPaymentAmountsByMode(laterPendingReceipts, 'CASH'),
        online_later_pending_received: sumPaymentAmountsByMode(laterPendingReceipts, 'ONLINE'),
        last_received_amount: Number(Math.max(
            Number(lastPayment?.collection_total_amount || 0),
            groupedLastReceivedAmount
        ).toFixed(2)),
        last_received_at: getPaymentEventTimeValue(lastPayment),
        last_received_mode: lastPayment?.payment_mode || null,
    };
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
    allocationKind = ALLOCATION_KINDS.CURRENT,
    settlementSourceBillId,
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
    const resolvedAllocationKind = ensureValidAllocationKind(allocationKind);
    const resolvedSettlementSourceBillId = resolveSettlementSourceBillId(settlementSourceBillId, bill.id);

    await connection.execute(
        `INSERT INTO tbl_bill_payments
         (bill_id, appointment_id, consultation_id, patient_id, payment_for, allocation_kind, settlement_source_bill_id, amount, pending_before, pending_after, payment_mode, transaction_reference, remark, collected_by_user_id, collected_by_role, collected_at, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), 'SUCCESS')`,
        [
            bill.id,
            bill.appointment_id,
            bill.consultation_id,
            bill.patient_id,
            paymentFor,
            resolvedAllocationKind,
            resolvedSettlementSourceBillId,
            normalizedAmount,
            dueAmount,
            nextPendingAmount,
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
        allocationKind: resolvedAllocationKind,
        settlementSourceBillId: resolvedSettlementSourceBillId,
        amount: normalizedAmount,
        pendingBefore: dueAmount,
        pendingAfter: nextPendingAmount,
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
            b.delivery_mode,
            b.delivery_details_json,
            b.created_at,
            b.updated_at,
            a.auid,
            COALESCE(a.appointment_date, DATE(b.created_at)) AS appointment_date,
            a.original_token_number,
            a.current_token_number AS token_number,
            COALESCE(
                a.live_queue_assigned_position,
                (
                    SELECT COUNT(*)
                    FROM tbl_appointments sibling
                    WHERE sibling.fk_branch_id = a.fk_branch_id
                      AND sibling.fk_slot_id = a.fk_slot_id
                      AND sibling.appointment_date = a.appointment_date
                      AND sibling.is_active = 1
                      AND COALESCE(sibling.original_token_number, sibling.current_token_number, sibling.token_number)
                          <= COALESCE(a.original_token_number, a.current_token_number, a.token_number)
                )
            ) AS queue_position,
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
         LEFT JOIN master_users p ON p.id = COALESCE(a.fk_patient_id, b.patient_id)
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

    const [paymentRows, previousPendingRows, items] = await Promise.all([
        query(
            `SELECT ${billPaymentSelectSql}
             ${billPaymentFromSql}
             WHERE bp.bill_id = ?
             ORDER BY bp.id ASC`,
            [billId]
        ),
        query(
            `SELECT ${billPaymentSelectSql}
             ${billPaymentFromSql}
             WHERE bp.settlement_source_bill_id = ?
               AND bp.bill_id <> ?
               AND bp.status = 'SUCCESS'
             ORDER BY bp.id ASC`,
            [billId, billId]
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

    const payments = paymentRows.map(mapBillPaymentRow);
    const previousPendingSettlements = previousPendingRows.map(mapBillPaymentRow);
    const successfulPayments = payments.filter((payment) => String(payment.status || '').toUpperCase() === 'SUCCESS');
    const collectedCash = successfulPayments.reduce(
        (sum, payment) => sum + (String(payment.payment_mode || '').toUpperCase() === 'CASH' ? Number(payment.amount || 0) : 0),
        0
    );
    const collectedOnline = successfulPayments.reduce(
        (sum, payment) => sum + (String(payment.payment_mode || '').toUpperCase() === 'ONLINE' ? Number(payment.amount || 0) : 0),
        0
    );

    return {
        ...summary,
        ...toPaymentSummary(collectedCash, collectedOnline),
        payments,
        previous_pending_settlements: previousPendingSettlements,
        payment_breakdown: buildBillPaymentBreakdown({
            summary,
            payments,
            previousPendingSettlements,
        }),
        payment_allocation: {
            towards_this_bill: Number(payments.reduce((sum, payment) => sum + Number(payment.amount || 0), 0).toFixed(2)),
            towards_previous_pending: Number(previousPendingSettlements.reduce((sum, payment) => sum + Number(payment.amount || 0), 0).toFixed(2)),
            previous_bills: previousPendingSettlements.map((payment) => ({
                bill_id: payment.bill_id,
                bill_number: payment.bill_number,
                amount: payment.amount,
                pending_before: payment.pending_before,
                pending_after: payment.pending_after,
                collected_at: payment.collected_at,
            })),
        },
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
            a.original_token_number,
            a.current_token_number AS token_number,
            COALESCE(
                a.live_queue_assigned_position,
                (
                    SELECT COUNT(*)
                    FROM tbl_appointments sibling
                    WHERE sibling.fk_branch_id = a.fk_branch_id
                      AND sibling.fk_slot_id = a.fk_slot_id
                      AND sibling.appointment_date = a.appointment_date
                      AND sibling.is_active = 1
                      AND COALESCE(sibling.original_token_number, sibling.current_token_number, sibling.token_number)
                          <= COALESCE(a.original_token_number, a.current_token_number, a.token_number)
                )
            ) AS queue_position,
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
         LEFT JOIN master_users p ON p.id = COALESCE(a.fk_patient_id, b.patient_id)
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
        .flatMap((bill) => [
            ...(bill.payments || []).map((payment) => ({
                ...payment,
                bill_id: bill.bill_id,
                bill_number: bill.bill_number,
                bill_type: bill.bill_type,
            })),
            ...(bill.previous_pending_settlements || []),
        ])
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
                original_token_number: firstRow.original_token_number,
                queue_position: firstRow.queue_position,
            }),
            queue_position: firstRow.queue_position,
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
    allocationKind = ALLOCATION_KINDS.CURRENT,
    settlementSourceBillId,
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
        allocationKind,
        settlementSourceBillId,
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

const createRepeatMedicineBill = async ({
    connection,
    patientId,
    branchId,
    sourceConsultationId,
    prescribedItems,
    additionalItems = [],
    courierCharge = 0,
    deliveryMode = 'HAND_DELIVERY',
    deliveryDetails = null,
    createdByUserId,
    remark = null,
}) => {
    const normalizedPrescribedItems = Array.isArray(prescribedItems) ? prescribedItems : [];
    const normalizedAdditionalItems = Array.isArray(additionalItems) ? additionalItems : [];
    const normalizedCourierCharge = normalizeAmount(courierCharge) ?? 0;
    const totalAmount = normalizeAmount(
        normalizedPrescribedItems.reduce((sum, item) => sum + (Number(item.amount) || 0), 0)
        + normalizedAdditionalItems.reduce((sum, item) => sum + (Number(item.amount) || 0), 0)
        + normalizedCourierCharge
    ) ?? 0;

    if (totalAmount <= 0) {
        throw new AppError('Repeat medicine total amount must be greater than 0', 400);
    }

    const billNumber = await generateBillNumber(connection);
    const extraReasonText = normalizedAdditionalItems
        .filter((item) => item.reason)
        .map((item) => `${item.medicine_value}: ${item.reason}`)
        .join('; ');
    const billRemark = [
        normalizedPrescribedItems.length > 0 ? 'Repeat Medicine' : 'Repeat Medicine - Medical Only',
        remark,
        extraReasonText ? `Medical Added Reason: ${extraReasonText}` : null,
        deliveryMode === 'COURIER' ? 'Delivery: Courier' : 'Delivery: Hand',
    ].filter(Boolean).join(' | ').slice(0, 255);
    const detailsJson = deliveryDetails ? JSON.stringify(deliveryDetails).slice(0, 2000) : null;

    const [insertResult] = await connection.execute(
        `INSERT INTO tbl_bills
         (bill_number, bill_type, appointment_id, consultation_id, patient_id, fk_branch_id, total_amount, paid_amount, pending_amount, payment_status, status, remark, delivery_mode, delivery_details_json, created_by, updated_by)
         VALUES (?, 'MEDICATION', NULL, ?, ?, ?, ?, 0, ?, 'UNPAID', 'ACTIVE', ?, ?, ?, ?, ?)`,
        [
            billNumber,
            sourceConsultationId,
            patientId,
            branchId,
            totalAmount,
            totalAmount,
            billRemark,
            deliveryMode,
            detailsJson,
            createdByUserId,
            createdByUserId,
        ]
    );

    const billId = insertResult.insertId;

    for (const item of normalizedPrescribedItems) {
        const itemAmount = normalizeAmount(item.amount) ?? 0;
        await connection.execute(
            `INSERT INTO tbl_bill_items
             (bill_id, consultation_medication_id, consultation_test_id, item_type, item_name, quantity, unit_price, amount)
             VALUES (?, ?, NULL, 'MEDICATION', ?, 1, ?, ?)`,
            [billId, item.consultation_medication_id, item.medicine_value, itemAmount, itemAmount]
        );
    }

    for (const item of normalizedAdditionalItems) {
        const itemAmount = normalizeAmount(item.amount) ?? 0;
        const itemName = (item.reason
            ? `${item.medicine_value} (Reason: ${item.reason})`
            : item.medicine_value
        ).slice(0, 255);
        await connection.execute(
            `INSERT INTO tbl_bill_items
             (bill_id, consultation_medication_id, consultation_test_id, item_type, item_name, quantity, unit_price, amount)
             VALUES (?, NULL, NULL, 'ADDITIONAL_MEDICATION', ?, 1, ?, ?)`,
            [billId, itemName, itemAmount, itemAmount]
        );
    }

    if (normalizedCourierCharge > 0) {
        await connection.execute(
            `INSERT INTO tbl_bill_items
             (bill_id, consultation_medication_id, consultation_test_id, item_type, item_name, quantity, unit_price, amount)
             VALUES (?, NULL, NULL, 'ADDITIONAL_MEDICATION', 'Courier Charge', 1, ?, ?)`,
            [billId, normalizedCourierCharge, normalizedCourierCharge]
        );
    }

    return {
        billId,
        created: true,
    };
};

module.exports = {
    PAYMENT_MODES,
    PAYMENT_SETTLEMENT_TYPES,
    ALLOCATION_KINDS,
    createConsultationBillForAppointment,
    transferConsultationBillToAppointment,
    collectConsultationBillPayment,
    collectMedicationBillPayment,
    createMedicationBillFromConsultation,
    createRepeatMedicineBill,
    getBillSummaryById,
    getBillDetailById,
    getAppointmentBillingSummaryByAppointmentId,
    normalizeAmount,
    toPaymentSummary,
    getMedicationPaymentSummaries,
};
