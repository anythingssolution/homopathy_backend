const AppError = require('../utils/AppError');
const { query } = require('../config/db');
const { decorateTokenFields } = require('../utils/tokenDisplay');
const { ALLOCATION_KINDS, normalizeAmount, collectMedicationBillPayment } = require('./billingService');

const ALLOCATION_ORDERS = Object.freeze({
    CURRENT_FIRST: 'CURRENT_FIRST',
    CURRENT_ONLY: 'CURRENT_ONLY',
    PREVIOUS_FIRST: 'PREVIOUS_FIRST',
});

const runSql = async (executor, sql, params = []) => {
    if (executor && typeof executor.execute === 'function') {
        const [rows] = await executor.execute(sql, params);
        return rows;
    }

    return query(sql, params);
};

const toIdList = (values) => [...new Set((Array.isArray(values) ? values : [values])
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value > 0))];

const ensureValidAllocationOrder = (allocationOrder) => {
    const normalized = String(allocationOrder || ALLOCATION_ORDERS.CURRENT_FIRST).trim().toUpperCase();

    if (!Object.values(ALLOCATION_ORDERS).includes(normalized)) {
        throw new AppError('allocation_order must be CURRENT_FIRST, CURRENT_ONLY or PREVIOUS_FIRST', 400);
    }

    return normalized;
};

const outstandingSelectSql = `
    b.id AS bill_id,
    b.bill_number,
    b.bill_type,
    b.consultation_id,
    b.appointment_id,
    b.patient_id,
    b.fk_branch_id AS branch_id,
    b.total_amount,
    b.paid_amount,
    b.pending_amount,
    b.payment_status,
    b.remark,
    b.created_at,
    COALESCE(a.appointment_date, DATE(b.created_at)) AS due_date,
    a.auid,
    a.current_token_number AS token_number,
    t.treatment_name,
    d.full_name AS doctor_name,
    br.branch_name,
    COALESCE(fm.full_name, p.full_name) AS patient_full_name
`;

const outstandingFromSql = `
    FROM tbl_bills b
    LEFT JOIN tbl_appointments a ON a.appointment_id = b.appointment_id
    LEFT JOIN tbl_consultations c ON c.id = b.consultation_id
    LEFT JOIN master_users d ON d.id = c.doctor_id
    LEFT JOIN master_treatments t ON t.id = a.fk_treatment_id
    LEFT JOIN master_clinic_branches br ON br.id = b.fk_branch_id
    LEFT JOIN master_users p ON p.id = b.patient_id
    LEFT JOIN tbl_patient_family_members fm ON fm.id = a.fk_patient_family_member_id
`;

const mapOutstandingBill = (row) => decorateTokenFields({
    bill_id: Number(row.bill_id),
    bill_number: row.bill_number,
    bill_type: row.bill_type,
    consultation_id: row.consultation_id ? Number(row.consultation_id) : null,
    appointment_id: row.appointment_id ? Number(row.appointment_id) : null,
    patient_id: Number(row.patient_id),
    branch_id: row.branch_id ? Number(row.branch_id) : null,
    total_amount: normalizeAmount(row.total_amount) ?? 0,
    paid_amount: normalizeAmount(row.paid_amount) ?? 0,
    pending_amount: normalizeAmount(row.pending_amount) ?? 0,
    payment_status: row.payment_status,
    remark: row.remark || null,
    created_at: row.created_at,
    due_date: row.due_date,
    auid: row.auid || null,
    token_number: row.token_number || null,
    treatment_name: row.appointment_id ? (row.treatment_name || null) : 'Repeat Medicine',
    doctor_name: row.doctor_name || null,
    branch_name: row.branch_name || null,
    patient_full_name: row.patient_full_name || null,
    is_repeat_medicine: !row.appointment_id,
});

const summarizeOutstandingBills = (bills = []) => {
    const totalPending = bills.reduce((sum, bill) => sum + (Number(bill.pending_amount) || 0), 0);

    return {
        total_pending: Number(totalPending.toFixed(2)),
        bills_count: bills.length,
        bills,
    };
};

const filterOutstandingBills = (bills = [], {
    excludeBillIds = [],
    excludeConsultationIds = [],
} = {}) => {
    const excludedBills = new Set(toIdList(excludeBillIds));
    const excludedConsultations = new Set(toIdList(excludeConsultationIds));

    return bills.filter((bill) => {
        if (excludedBills.has(Number(bill.bill_id))) {
            return false;
        }

        if (bill.consultation_id && excludedConsultations.has(Number(bill.consultation_id))) {
            return false;
        }

        return (Number(bill.pending_amount) || 0) > 0;
    });
};

const listOutstandingMedicationBills = async ({
    executor = null,
    patientIds,
    branchId = null,
    excludeBillIds = [],
    excludeConsultationIds = [],
    forUpdate = false,
} = {}) => {
    const ids = toIdList(patientIds);

    if (ids.length === 0) {
        return [];
    }

    const conditions = [
        `b.patient_id IN (${ids.map(() => '?').join(',')})`,
        `b.status = 'ACTIVE'`,
        `b.bill_type = 'MEDICATION'`,
        `b.pending_amount > 0`,
    ];
    const params = [...ids];

    if (branchId) {
        conditions.push('b.fk_branch_id = ?');
        params.push(Number(branchId));
    }

    const excludedBills = toIdList(excludeBillIds);
    if (excludedBills.length > 0) {
        conditions.push(`b.id NOT IN (${excludedBills.map(() => '?').join(',')})`);
        params.push(...excludedBills);
    }

    const excludedConsultations = toIdList(excludeConsultationIds);
    if (excludedConsultations.length > 0) {
        conditions.push(`(b.consultation_id IS NULL OR b.consultation_id NOT IN (${excludedConsultations.map(() => '?').join(',')}))`);
        params.push(...excludedConsultations);
    }

    if (forUpdate) {
        const lockConditions = [
            `patient_id IN (${ids.map(() => '?').join(',')})`,
            `status = 'ACTIVE'`,
            `bill_type = 'MEDICATION'`,
            `pending_amount > 0`,
        ];
        const lockParams = [...ids];

        if (branchId) {
            lockConditions.push('fk_branch_id = ?');
            lockParams.push(Number(branchId));
        }

        if (excludedBills.length > 0) {
            lockConditions.push(`id NOT IN (${excludedBills.map(() => '?').join(',')})`);
            lockParams.push(...excludedBills);
        }

        if (excludedConsultations.length > 0) {
            lockConditions.push(`(consultation_id IS NULL OR consultation_id NOT IN (${excludedConsultations.map(() => '?').join(',')}))`);
            lockParams.push(...excludedConsultations);
        }

        const lockedRows = await runSql(
            executor,
            `SELECT id
             FROM tbl_bills
             WHERE ${lockConditions.join(' AND ')}
             ORDER BY id ASC
             FOR UPDATE`,
            lockParams
        );

        if (lockedRows.length === 0) {
            return [];
        }

        const lockedIds = lockedRows.map((row) => Number(row.id));
        conditions.push(`b.id IN (${lockedIds.map(() => '?').join(',')})`);
        params.push(...lockedIds);
    }

    const rows = await runSql(
        executor,
        `SELECT ${outstandingSelectSql}
         ${outstandingFromSql}
         WHERE ${conditions.join(' AND ')}
         ORDER BY COALESCE(a.appointment_date, DATE(b.created_at)) ASC, b.id ASC`,
        params
    );

    return rows.map(mapOutstandingBill);
};

const getMedicationOutstandingMap = async ({
    patientIds,
    branchId = null,
    excludeConsultationIds = [],
} = {}) => {
    const bills = await listOutstandingMedicationBills({
        patientIds,
        branchId,
        excludeConsultationIds,
    });
    const map = new Map();

    bills.forEach((bill) => {
        const list = map.get(bill.patient_id) || [];
        list.push(bill);
        map.set(bill.patient_id, list);
    });

    return map;
};

const getPatientMedicationOutstanding = async ({
    executor = null,
    patientId,
    branchId = null,
    excludeBillIds = [],
    excludeConsultationIds = [],
    forUpdate = false,
} = {}) => {
    const bills = await listOutstandingMedicationBills({
        executor,
        patientIds: [patientId],
        branchId,
        excludeBillIds,
        excludeConsultationIds,
        forUpdate,
    });

    return summarizeOutstandingBills(bills);
};

const allocateReceivedAmount = ({
    receivedAmount,
    currentPending = 0,
    previousBills = [],
    allocationOrder = ALLOCATION_ORDERS.CURRENT_FIRST,
} = {}) => {
    const received = normalizeAmount(receivedAmount);
    const currentDue = normalizeAmount(currentPending) ?? 0;
    const order = ensureValidAllocationOrder(allocationOrder);

    if (received === null) {
        throw new AppError('amount must be a valid non-negative number', 400);
    }

    const previous = (Array.isArray(previousBills) ? previousBills : [])
        .map((bill) => ({
            bill_id: Number(bill.bill_id || bill.bill_id),
            pending_amount: normalizeAmount(bill.pending_amount) ?? 0,
        }))
        .filter((bill) => Number.isInteger(bill.bill_id) && bill.bill_id > 0 && bill.pending_amount > 0);

    const previousTotal = Number(previous.reduce((sum, bill) => sum + bill.pending_amount, 0).toFixed(2));
    const totalDue = Number((currentDue + previousTotal).toFixed(2));

    if (received > totalDue) {
        throw new AppError('amount cannot be greater than total due including previous pending', 400);
    }

    let remaining = received;
    let currentApplied = 0;
    const previousAllocations = previous.map((bill) => ({
        bill_id: bill.bill_id,
        amount: 0,
        pending_before: bill.pending_amount,
    }));

    const applyToPrevious = () => {
        previousAllocations.forEach((allocation) => {
            if (remaining <= 0) {
                return;
            }

            const available = Number((allocation.pending_before - allocation.amount).toFixed(2));
            const applied = Math.min(available, remaining);
            allocation.amount = Number((allocation.amount + applied).toFixed(2));
            remaining = Number((remaining - applied).toFixed(2));
        });
    };

    const applyToCurrent = () => {
        currentApplied = Math.min(currentDue, remaining);
        remaining = Number((remaining - currentApplied).toFixed(2));
    };

    if (order === ALLOCATION_ORDERS.PREVIOUS_FIRST) {
        applyToPrevious();
        applyToCurrent();
    } else if (order === ALLOCATION_ORDERS.CURRENT_ONLY) {
        applyToCurrent();
    } else {
        applyToCurrent();
        applyToPrevious();
    }

    if (order === ALLOCATION_ORDERS.CURRENT_ONLY && remaining > 0) {
        throw new AppError('amount cannot be greater than today\'s bill unless previous pending is also collected', 400);
    }

    const previousAppliedTotal = Number(previousAllocations.reduce((sum, item) => sum + item.amount, 0).toFixed(2));

    return {
        allocation_order: order,
        received,
        current_applied: currentApplied,
        current_remaining: Number((currentDue - currentApplied).toFixed(2)),
        previous_allocations: previousAllocations
            .filter((item) => item.amount > 0)
            .map((item) => ({
                bill_id: item.bill_id,
                amount: item.amount,
                pending_before: item.pending_before,
                pending_after: Number((item.pending_before - item.amount).toFixed(2)),
            })),
        previous_applied: previousAppliedTotal,
        previous_remaining: Number((previousTotal - previousAppliedTotal).toFixed(2)),
        total_due: totalDue,
        total_remaining: Number((totalDue - received).toFixed(2)),
    };
};

const applyMedicationReceipt = async ({
    connection,
    patientId,
    currentBillId = null,
    receivedAmount,
    paymentMode,
    transactionReference = null,
    remark = null,
    collectedByUserId,
    collectedByRole,
    allocationOrder = ALLOCATION_ORDERS.CURRENT_FIRST,
    branchId = null,
    sourceConsultationId = null,
} = {}) => {
    const received = normalizeAmount(receivedAmount) ?? 0;
    let currentPending = 0;

    if (currentBillId) {
        const [currentRows] = await connection.execute(
            `SELECT id, pending_amount, payment_status, consultation_id
             FROM tbl_bills
             WHERE id = ?
               AND patient_id = ?
               AND bill_type = 'MEDICATION'
               AND status = 'ACTIVE'
             LIMIT 1
             FOR UPDATE`,
            [currentBillId, patientId]
        );

        if (currentRows.length === 0) {
            throw new AppError('Medication bill not found', 404);
        }

        currentPending = normalizeAmount(currentRows[0].pending_amount) ?? 0;
    }

    const previous = await listOutstandingMedicationBills({
        executor: connection,
        patientIds: [patientId],
        branchId,
        excludeBillIds: currentBillId ? [currentBillId] : [],
        forUpdate: true,
    });

    const allocation = allocateReceivedAmount({
        receivedAmount: received,
        currentPending,
        previousBills: previous,
        allocationOrder,
    });

    if (received <= 0) {
        return {
            ...allocation,
            current_bill_id: currentBillId,
            payments: [],
        };
    }

    const settlementRemark = remark
        || (sourceConsultationId
            ? `Dues settlement during consultation ${sourceConsultationId}`
            : 'Medication dues settlement');
    const payments = [];

    if (allocation.current_applied > 0 && currentBillId) {
        const result = await collectMedicationBillPayment({
            connection,
            billId: currentBillId,
            amount: allocation.current_applied,
            paymentMode,
            transactionReference,
            remark: settlementRemark,
            collectedByUserId,
            collectedByRole,
            allocationKind: ALLOCATION_KINDS.CURRENT,
            settlementSourceBillId: currentBillId,
        });
        payments.push({
            bill_id: currentBillId,
            amount: allocation.current_applied,
            kind: 'CURRENT',
            pending_before: result.pendingBefore,
            pending_after: result.pendingAfter,
            payment_status: result.paymentStatus,
        });
    }

    for (const item of allocation.previous_allocations) {
        const result = await collectMedicationBillPayment({
            connection,
            billId: item.bill_id,
            amount: item.amount,
            paymentMode,
            transactionReference,
            remark: settlementRemark,
            collectedByUserId,
            collectedByRole,
            allocationKind: ALLOCATION_KINDS.PREVIOUS,
            settlementSourceBillId: currentBillId || null,
        });
        payments.push({
            bill_id: item.bill_id,
            amount: item.amount,
            kind: 'PREVIOUS',
            pending_before: result.pendingBefore,
            pending_after: result.pendingAfter,
            payment_status: result.paymentStatus,
        });
    }

    return {
        ...allocation,
        current_bill_id: currentBillId,
        payments,
    };
};

const buildAccountDuesPayload = (bills = [], extras = {}) => ({
    ...summarizeOutstandingBills(bills),
    ...extras,
});

module.exports = {
    ALLOCATION_ORDERS,
    allocateReceivedAmount,
    applyMedicationReceipt,
    buildAccountDuesPayload,
    ensureValidAllocationOrder,
    filterOutstandingBills,
    getMedicationOutstandingMap,
    getPatientMedicationOutstanding,
    listOutstandingMedicationBills,
    summarizeOutstandingBills,
};
