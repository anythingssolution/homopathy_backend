const { query, withTransaction } = require('../config/db');
const AppError = require('../utils/AppError');
const { createNotificationForUser } = require('../utils/notificationService');

const FOLLOW_UP_STATUS = {
    PENDING: 'PENDING',
    NOTIFIED: 'NOTIFIED',
    CONFIRMED_BOOKED: 'CONFIRMED_BOOKED',
    CANCELLED: 'CANCELLED',
    CLOSED_BY_DOCTOR: 'CLOSED_BY_DOCTOR',
};

const VISIT_TYPE = {
    FIRST_CONSULTATION: 'FIRST_CONSULTATION',
    FOLLOW_UP_VISIT: 'FOLLOW_UP_VISIT',
    ACUTE_TREATMENT: 'ACUTE_TREATMENT',
    CHRONIC_CASE_DISCUSSION: 'CHRONIC_CASE_DISCUSSION',
    OTHER: 'OTHER',
};

const FALLBACK_TREATMENT_ID_MAP = {
    1: VISIT_TYPE.FIRST_CONSULTATION,
    2: VISIT_TYPE.FOLLOW_UP_VISIT,
    3: VISIT_TYPE.ACUTE_TREATMENT,
    4: VISIT_TYPE.CHRONIC_CASE_DISCUSSION,
};

const normalizeText = (value) => String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

const getVisitTypeCode = ({ treatmentId = null, treatmentName = null, treatmentCode = null }) => {
    const normalizedCode = String(treatmentCode || '').trim().toUpperCase();
    if (Object.values(VISIT_TYPE).includes(normalizedCode)) {
        return normalizedCode;
    }

    const normalizedName = normalizeText(treatmentName);

    if (normalizedName === 'first consultation') {
        return VISIT_TYPE.FIRST_CONSULTATION;
    }

    if ([
        'follow up visit',
        'followup visit',
        'follow up consultation',
        'followup consultation',
    ].includes(normalizedName)) {
        return VISIT_TYPE.FOLLOW_UP_VISIT;
    }

    if (normalizedName === 'acute treatment') {
        return VISIT_TYPE.ACUTE_TREATMENT;
    }

    if (normalizedName === 'chronic case discussion') {
        return VISIT_TYPE.CHRONIC_CASE_DISCUSSION;
    }

    return FALLBACK_TREATMENT_ID_MAP[Number(treatmentId)] || VISIT_TYPE.OTHER;
};

const decorateTreatmentsWithVisitType = (treatments = []) => treatments.map((treatment) => ({
    ...treatment,
    visit_type_code: getVisitTypeCode({
        treatmentId: treatment.id,
        treatmentName: treatment.treatment_name,
        treatmentCode: treatment.treatment_code,
    }),
}));

const buildFollowUpMeta = (treatments = []) => {
    const typedTreatments = decorateTreatmentsWithVisitType(treatments);
    const idsByCode = typedTreatments.reduce((accumulator, treatment) => {
        if (!accumulator[treatment.visit_type_code]) {
            accumulator[treatment.visit_type_code] = [];
        }

        accumulator[treatment.visit_type_code].push(Number(treatment.id));
        return accumulator;
    }, {});

    return {
        treatments: typedTreatments,
        meta: {
            follow_up_treatment_ids: idsByCode[VISIT_TYPE.FOLLOW_UP_VISIT] || [],
            root_follow_up_trigger_treatment_ids: [
                ...(idsByCode[VISIT_TYPE.FIRST_CONSULTATION] || []),
                ...(idsByCode[VISIT_TYPE.CHRONIC_CASE_DISCUSSION] || []),
            ],
            chain_continuation_treatment_ids: [
                ...(idsByCode[VISIT_TYPE.FIRST_CONSULTATION] || []),
                ...(idsByCode[VISIT_TYPE.FOLLOW_UP_VISIT] || []),
                ...(idsByCode[VISIT_TYPE.CHRONIC_CASE_DISCUSSION] || []),
            ],
        },
    };
};

const isFollowUpBookingVisitType = (visitTypeCode) => visitTypeCode === VISIT_TYPE.FOLLOW_UP_VISIT;

const canCreateNextFollowUpForVisitType = (visitTypeCode) => [
    VISIT_TYPE.FIRST_CONSULTATION,
    VISIT_TYPE.FOLLOW_UP_VISIT,
    VISIT_TYPE.CHRONIC_CASE_DISCUSSION,
].includes(visitTypeCode);

const executeRows = async (executor, sql, params = []) => {
    if (typeof executor === 'function') {
        return executor(sql, params);
    }

    const [rows] = await executor.execute(sql, params);
    return rows;
};

const getTreatmentById = async (executor, treatmentId) => {
    const rows = await executeRows(
        executor,
        `SELECT id, treatment_code, treatment_name
         FROM master_treatments
         WHERE id = ?
         LIMIT 1`,
        [treatmentId]
    );

    return rows[0] || null;
};

const getAppointmentFollowUpContext = async (executor, appointmentId) => {
    const rows = await executeRows(
        executor,
        `SELECT
            a.appointment_id,
            a.parent_appointment_id,
            a.fk_patient_id,
            a.fk_patient_family_member_id,
            a.fk_treatment_id,
            a.appointment_date,
            a.status,
            a.is_active,
            t.treatment_code,
            t.treatment_name
         FROM tbl_appointments a
         JOIN master_treatments t ON t.id = a.fk_treatment_id
         WHERE a.appointment_id = ?
         LIMIT 1`,
        [appointmentId]
    );

    if (rows.length === 0) {
        return null;
    }

    const appointment = rows[0];

    return {
        ...appointment,
        visit_type_code: getVisitTypeCode({
            treatmentId: appointment.fk_treatment_id,
            treatmentName: appointment.treatment_name,
            treatmentCode: appointment.treatment_code,
        }),
    };
};

const createPendingFollowUp = async ({
    connection,
    parentAppointmentId,
    patientId,
    familyMemberId = null,
    dueDate,
}) => {
    await connection.execute(
        `INSERT INTO tbl_pending_followups
         (parent_appointment_id, fk_patient_id, fk_family_member_id, due_date, status)
         VALUES (?, ?, ?, ?, ?)`,
        [
            parentAppointmentId,
            patientId,
            familyMemberId,
            dueDate,
            FOLLOW_UP_STATUS.PENDING,
        ]
    );
};

const closePendingFollowUpsForParent = async ({
    connection,
    parentAppointmentId,
    status = FOLLOW_UP_STATUS.CLOSED_BY_DOCTOR,
}) => {
    await connection.execute(
        `UPDATE tbl_pending_followups
         SET status = ?,
             updated_at = CURRENT_TIMESTAMP
         WHERE parent_appointment_id = ?
           AND status IN (?, ?)`,
        [
            status,
            parentAppointmentId,
            FOLLOW_UP_STATUS.PENDING,
            FOLLOW_UP_STATUS.NOTIFIED,
        ]
    );
};

const listEligibleFollowUps = async ({
    patientId,
    familyMemberId = undefined,
}) => {
    const conditions = [
        'pf.fk_patient_id = ?',
        'pf.status IN (?, ?)',
    ];
    const params = [
        patientId,
        FOLLOW_UP_STATUS.PENDING,
        FOLLOW_UP_STATUS.NOTIFIED,
    ];

    if (familyMemberId === null) {
        conditions.push('pf.fk_family_member_id IS NULL');
    } else if (familyMemberId !== undefined) {
        conditions.push('pf.fk_family_member_id = ?');
        params.push(familyMemberId);
    }

    const rows = await query(
        `SELECT
            pf.id AS pending_followup_id,
            pf.parent_appointment_id,
            pf.fk_patient_id,
            pf.fk_family_member_id,
            pf.due_date,
            pf.status,
            pa.auid AS parent_auid,
            pa.appointment_date AS parent_appointment_date,
            pa.fk_branch_id,
            b.branch_name,
            pa.fk_treatment_id,
            t.treatment_name,
            COALESCE(fm.full_name, p.full_name) AS visiting_patient_name,
            p.full_name AS primary_patient_full_name,
            fm.relationship AS family_member_relationship,
            d.full_name AS doctor_name
         FROM tbl_pending_followups pf
         JOIN tbl_appointments pa
           ON pa.appointment_id = pf.parent_appointment_id
         JOIN master_clinic_branches b
           ON b.id = pa.fk_branch_id
         JOIN master_treatments t
           ON t.id = pa.fk_treatment_id
         JOIN master_users p
           ON p.id = pf.fk_patient_id
         LEFT JOIN tbl_patient_family_members fm
           ON fm.id = pf.fk_family_member_id
         LEFT JOIN tbl_consultations c
           ON c.appointment_id = pa.appointment_id
         LEFT JOIN master_users d
           ON d.id = c.doctor_id
         WHERE ${conditions.join(' AND ')}
         ORDER BY pf.due_date ASC, pf.id ASC`,
        params
    );

    return rows.map((row) => ({
        ...row,
        is_family_member_followup: row.fk_family_member_id ? 1 : 0,
        visit_type_code: getVisitTypeCode({
            treatmentId: row.fk_treatment_id,
            treatmentName: row.treatment_name,
        }),
    }));
};

const lockEligiblePendingFollowUp = async ({
    connection,
    parentAppointmentId,
    patientId,
    familyMemberId = null,
}) => {
    const params = [
        parentAppointmentId,
        patientId,
        FOLLOW_UP_STATUS.PENDING,
        FOLLOW_UP_STATUS.NOTIFIED,
    ];
    let familyMemberCondition = 'pf.fk_family_member_id IS NULL';

    if (familyMemberId) {
        familyMemberCondition = 'pf.fk_family_member_id = ?';
        params.push(familyMemberId);
    }

    const [rows] = await connection.execute(
        `SELECT pf.id, pf.parent_appointment_id
         FROM tbl_pending_followups pf
         WHERE pf.parent_appointment_id = ?
           AND pf.fk_patient_id = ?
           AND pf.status IN (?, ?)
           AND ${familyMemberCondition}
         ORDER BY pf.id ASC
         LIMIT 1
         FOR UPDATE`,
        params
    );

    return rows[0] || null;
};

const markPendingFollowUpBooked = async ({
    connection,
    pendingFollowupId,
}) => {
    await connection.execute(
        `UPDATE tbl_pending_followups
         SET status = ?,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [FOLLOW_UP_STATUS.CONFIRMED_BOOKED, pendingFollowupId]
    );
};

const getAppointmentChain = async (appointmentId) => {
    const rows = await query(
        `WITH RECURSIVE appointment_chain AS (
            SELECT
                a.appointment_id,
                a.parent_appointment_id,
                a.appointment_id AS root_appointment_id
            FROM tbl_appointments a
            WHERE a.appointment_id = ?

            UNION ALL

            SELECT
                parent.appointment_id,
                parent.parent_appointment_id,
                parent.appointment_id AS root_appointment_id
            FROM tbl_appointments parent
            JOIN appointment_chain chain
              ON chain.parent_appointment_id = parent.appointment_id
        ),
        root_node AS (
            SELECT appointment_id AS root_appointment_id
            FROM appointment_chain
            WHERE parent_appointment_id IS NULL
            ORDER BY appointment_id ASC
            LIMIT 1
        ),
        descendants AS (
            SELECT
                a.appointment_id,
                a.parent_appointment_id,
                0 AS depth
            FROM tbl_appointments a
            JOIN root_node rn ON rn.root_appointment_id = a.appointment_id

            UNION ALL

            SELECT
                child.appointment_id,
                child.parent_appointment_id,
                descendants.depth + 1 AS depth
            FROM tbl_appointments child
            JOIN descendants ON descendants.appointment_id = child.parent_appointment_id
        )
        SELECT
            d.depth,
            a.appointment_id,
            a.parent_appointment_id,
            a.auid,
            a.fk_patient_id,
            a.fk_patient_family_member_id,
            a.fk_branch_id,
            b.branch_name,
            a.fk_treatment_id,
            t.treatment_name,
            a.fk_slot_id,
            s.slot_name,
            COALESCE(sto.override_start_time, s.start_time) AS start_time,
            COALESCE(sto.override_end_time, s.end_time) AS end_time,
            a.current_token_number AS token_number,
            a.appointment_date,
            a.status,
            a.is_active,
            a.symptoms,
            COALESCE(fm.full_name, p.full_name) AS patient_full_name,
            p.full_name AS primary_patient_full_name,
            fm.relationship AS family_member_relationship,
            c.id AS consultation_id,
            c.medication_duration_days,
            c.follow_up_chain_closed,
            c.workflow_status,
            c.created_at AS consultation_created_at
         FROM descendants d
         JOIN tbl_appointments a
           ON a.appointment_id = d.appointment_id
         JOIN master_clinic_branches b
           ON b.id = a.fk_branch_id
         JOIN master_treatments t
           ON t.id = a.fk_treatment_id
         JOIN master_slots s
           ON s.id = a.fk_slot_id
         LEFT JOIN tbl_doctor_slot_time_overrides sto
           ON sto.fk_branch_id = a.fk_branch_id
          AND sto.fk_slot_id = a.fk_slot_id
          AND sto.appointment_date = a.appointment_date
          AND sto.status = 'ACTIVE'
         JOIN master_users p
           ON p.id = a.fk_patient_id
         LEFT JOIN tbl_patient_family_members fm
           ON fm.id = a.fk_patient_family_member_id
         LEFT JOIN tbl_consultations c
           ON c.appointment_id = a.appointment_id
         ORDER BY a.appointment_date ASC, d.depth ASC, a.appointment_id ASC`,
        [appointmentId]
    );

    return rows.map((row) => ({
        ...row,
        visit_type_code: getVisitTypeCode({
            treatmentId: row.fk_treatment_id,
            treatmentName: row.treatment_name,
        }),
    }));
};

let notifierInterval = null;
let isNotifierRunning = false;

const processDuePendingFollowUps = async () => {
    if (isNotifierRunning) {
        return;
    }

    isNotifierRunning = true;

    try {
        const dueRows = await query(
            `SELECT
                pf.id,
                pf.parent_appointment_id,
                pf.fk_patient_id,
                pf.fk_family_member_id,
                pf.due_date,
                pa.appointment_date AS parent_appointment_date,
                t.treatment_name,
                d.full_name AS doctor_name,
                COALESCE(fm.full_name, p.full_name) AS visiting_patient_name
             FROM tbl_pending_followups pf
             JOIN tbl_appointments pa
               ON pa.appointment_id = pf.parent_appointment_id
             JOIN master_treatments t
               ON t.id = pa.fk_treatment_id
             JOIN master_users p
               ON p.id = pf.fk_patient_id
             LEFT JOIN tbl_patient_family_members fm
               ON fm.id = pf.fk_family_member_id
             LEFT JOIN tbl_consultations c
               ON c.appointment_id = pa.appointment_id
             LEFT JOIN master_users d
               ON d.id = c.doctor_id
             WHERE pf.status = ?
               AND pf.due_date <= CURDATE()
             ORDER BY pf.due_date ASC, pf.id ASC`,
            [FOLLOW_UP_STATUS.PENDING]
        );

        for (const row of dueRows) {
            await createNotificationForUser({
                userId: row.fk_patient_id,
                branchId: null,
                roleCode: 'PAT',
                type: 'FOLLOW_UP_DUE',
                title: 'Follow-up due',
                message: `${row.doctor_name || 'Doctor'} advised a follow-up for ${row.visiting_patient_name || 'the patient'} based on the visit dated ${row.parent_appointment_date}.`,
                entityType: 'pending_followup',
                entityId: row.id,
                emitEvent: 'notification.new',
                emitPayload: {
                    type: 'FOLLOW_UP_DUE',
                    pending_followup_id: row.id,
                    parent_appointment_id: row.parent_appointment_id,
                    due_date: row.due_date,
                    treatment_name: row.treatment_name,
                },
            });

            await query(
                `UPDATE tbl_pending_followups
                 SET status = ?,
                     updated_at = CURRENT_TIMESTAMP
                 WHERE id = ?`,
                [FOLLOW_UP_STATUS.NOTIFIED, row.id]
            );
        }
    } catch (error) {
        console.error('Pending follow-up notifier failed:', error);
    } finally {
        isNotifierRunning = false;
    }
};

const startPendingFollowUpNotifier = ({
    intervalMs = 60 * 1000,
} = {}) => {
    if (notifierInterval) {
        return;
    }

    processDuePendingFollowUps();

    notifierInterval = setInterval(() => {
        processDuePendingFollowUps();
    }, Math.max(15 * 1000, Number(intervalMs) || 60 * 1000));
};

const stopPendingFollowUpNotifier = () => {
    if (notifierInterval) {
        clearInterval(notifierInterval);
        notifierInterval = null;
    }
};

const createNextFollowUpIfNeeded = async ({
    connection = null,
    appointmentId,
    followUpAfterDays,
    followUpChainClosed = false,
}) => {
    if (followUpChainClosed) {
        return null;
    }

    const run = async (activeConnection) => {
        const executor = activeConnection || query;
        const appointment = await getAppointmentFollowUpContext(executor, appointmentId);

        if (!appointment) {
            throw new AppError('Appointment not found for follow-up creation', 404);
        }

        if (!canCreateNextFollowUpForVisitType(appointment.visit_type_code)) {
            return null;
        }

        await closePendingFollowUpsForParent({
            connection: activeConnection,
            parentAppointmentId: appointmentId,
        });

        const apptDate = new Date(appointment.appointment_date);
        const y = apptDate.getFullYear();
        const m = String(apptDate.getMonth() + 1).padStart(2, '0');
        const d = String(apptDate.getDate()).padStart(2, '0');

        const baseDate = new Date(`${y}-${m}-${d}T00:00:00Z`);
        baseDate.setUTCDate(baseDate.getUTCDate() + Number(followUpAfterDays || 15));
        const dueDate = baseDate.toISOString().slice(0, 10);

        await createPendingFollowUp({
            connection: activeConnection,
            parentAppointmentId: appointmentId,
            patientId: Number(appointment.fk_patient_id),
            familyMemberId: appointment.fk_patient_family_member_id ? Number(appointment.fk_patient_family_member_id) : null,
            dueDate,
        });

        return {
            parent_appointment_id: appointmentId,
            due_date: dueDate,
            visit_type_code: appointment.visit_type_code,
        };
    };

    if (connection) {
        return run(connection);
    }

    return withTransaction(async (transactionConnection) => run(transactionConnection));
};

module.exports = {
    FOLLOW_UP_STATUS,
    VISIT_TYPE,
    buildFollowUpMeta,
    decorateTreatmentsWithVisitType,
    getVisitTypeCode,
    isFollowUpBookingVisitType,
    canCreateNextFollowUpForVisitType,
    getTreatmentById,
    getAppointmentFollowUpContext,
    listEligibleFollowUps,
    lockEligiblePendingFollowUp,
    markPendingFollowUpBooked,
    closePendingFollowUpsForParent,
    getAppointmentChain,
    createNextFollowUpIfNeeded,
    processDuePendingFollowUps,
    startPendingFollowUpNotifier,
    stopPendingFollowUpNotifier,
};
