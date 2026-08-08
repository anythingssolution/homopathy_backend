const AppError = require('../utils/AppError');

const DISPENSE_STATUSES = new Set(['ACTIVE', 'VOID']);

const toAmount = (value, fieldName = 'amount') => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) {
        throw new AppError(`${fieldName} must be a valid non-negative number`, 400);
    }

    return Number(parsed.toFixed(2));
};

const toCents = (value) => Math.round(toAmount(value) * 100);
const fromCents = (value) => Number((value / 100).toFixed(2));

const normalizeDispenseStatus = (value) => {
    const normalized = String(value || 'ACTIVE').trim().toUpperCase();
    if (!DISPENSE_STATUSES.has(normalized)) {
        throw new AppError('dispense_status must be ACTIVE or VOID', 400);
    }

    return normalized;
};

const ensureDispensingMutationAllowed = ({ workflowStatus, hasPaidBill }) => {
    if (workflowStatus !== 'READY_FOR_MEDICAL') {
        throw new AppError('Only medical-ready prescriptions can be changed', 409);
    }

    if (hasPaidBill) {
        throw new AppError('Paid or partially paid medication bills cannot be changed', 409);
    }
};

const validatePrescribedDispensingItems = ({ submittedItems, prescribedMedications, existingItems }) => {
    const prescribedById = new Map(
        prescribedMedications.map((item) => [Number(item.consultation_medication_id), item])
    );
    const existingByMedicationId = new Map(
        existingItems.map((item) => [Number(item.consultation_medication_id), item])
    );
    const seenIds = new Set();

    const normalizedItems = submittedItems.map((item, index) => {
        const medicationId = Number(item?.consultation_medication_id);
        if (!Number.isInteger(medicationId) || medicationId <= 0) {
            throw new AppError(`medications[${index}].consultation_medication_id is required`, 400);
        }

        if (seenIds.has(medicationId)) {
            throw new AppError(`Duplicate consultation medication id ${medicationId}`, 400);
        }
        seenIds.add(medicationId);

        const prescribed = prescribedById.get(medicationId);
        if (!prescribed) {
            throw new AppError(`Medication ${medicationId} does not belong to this Doctor prescription`, 400);
        }

        const submittedMedicineValue = String(item?.medicine_value || '').trim();
        if (submittedMedicineValue !== String(prescribed.medicine_value || '').trim()) {
            throw new AppError(`Medication ${medicationId} name does not match the Doctor prescription`, 400);
        }

        const dispenseStatus = normalizeDispenseStatus(item?.dispense_status);
        const voidReason = item?.void_reason ? String(item.void_reason).trim() : null;
        if (dispenseStatus === 'VOID' && !voidReason) {
            throw new AppError(`Removal reason is required for medication ${medicationId}`, 400);
        }

        const existing = existingByMedicationId.get(medicationId) || null;
        const submittedVersion = item?.version === undefined || item?.version === null || item?.version === ''
            ? null
            : Number(item.version);

        if (submittedVersion !== null && (!Number.isInteger(submittedVersion) || submittedVersion < 0)) {
            throw new AppError(`medications[${index}].version must be a non-negative integer`, 400);
        }

        if (existing && submittedVersion !== null && submittedVersion !== Number(existing.version)) {
            throw new AppError(`Medication ${medicationId} was changed by another user. Please reload.`, 409);
        }

        if (!existing && submittedVersion !== null && submittedVersion !== 0) {
            throw new AppError(`Medication ${medicationId} has a stale version. Please reload.`, 409);
        }

        return {
            consultation_medication_id: medicationId,
            medicine_value: prescribed.medicine_value,
            amount: toAmount(item?.amount, `medications[${index}].amount`),
            dispense_status: dispenseStatus,
            void_reason: dispenseStatus === 'VOID' ? voidReason : null,
            existing,
        };
    });

    if (seenIds.size !== prescribedById.size) {
        throw new AppError('Every Doctor-prescribed medicine must remain in the dispensing list', 400);
    }

    return normalizedItems;
};

const calculateDispensingTotal = ({ prescribedItems, additionalItems = [], tests = [] }) => {
    const activePrescribedCents = prescribedItems
        .filter((item) => item.dispense_status === 'ACTIVE')
        .reduce((sum, item) => sum + toCents(item.amount), 0);
    const additionalCents = additionalItems.reduce((sum, item) => sum + toCents(item.amount), 0);
    const testCents = tests.reduce((sum, item) => sum + toCents(item.amount), 0);

    return fromCents(activePrescribedCents + additionalCents + testCents);
};

const getBillableDispensingItems = (items) => items.filter(
    (item) => String(item.dispense_status || 'ACTIVE').toUpperCase() === 'ACTIVE'
);

const projectDispensingStatus = (medication, overlayItem = null) => {
    const source = overlayItem || medication || {};
    const rawStatus = source.dispense_status ? String(source.dispense_status).trim().toUpperCase() : null;
    const dispenseStatus = DISPENSE_STATUSES.has(rawStatus) ? rawStatus : null;

    return {
        ...medication,
        dispense_status: dispenseStatus,
        void_reason: dispenseStatus === 'VOID' ? source.void_reason || null : null,
        voided_by: dispenseStatus === 'VOID' ? source.voided_by || null : null,
        voided_at: dispenseStatus === 'VOID' ? source.voided_at || null : null,
        dispensing_version: source.version === undefined || source.version === null
            ? null
            : Number(source.version),
    };
};

const resolveDispensingEventType = ({ existing, amount, dispenseStatus, voidReason = null }) => {
    if (!existing) {
        return 'CREATED';
    }

    const oldStatus = String(existing.dispense_status || 'ACTIVE').toUpperCase();
    if (oldStatus !== dispenseStatus) {
        return dispenseStatus === 'VOID' ? 'VOIDED' : 'RESTORED';
    }

    if (toCents(existing.amount) !== toCents(amount)) {
        return 'PRICE_UPDATED';
    }

    if (dispenseStatus === 'VOID' && String(existing.void_reason || '').trim() !== String(voidReason || '').trim()) {
        return 'VOIDED';
    }

    return null;
};

module.exports = {
    calculateDispensingTotal,
    ensureDispensingMutationAllowed,
    getBillableDispensingItems,
    normalizeDispenseStatus,
    projectDispensingStatus,
    resolveDispensingEventType,
    toAmount,
    validatePrescribedDispensingItems,
};
