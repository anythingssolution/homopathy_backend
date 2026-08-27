const {
    query,
    AppError,
    asyncHandler,
    decorateTokenFields,
    getAppointmentPatientColumns,
    getAppointmentPatientJoin,
    toPositiveInt,
    isValidDateString,
    normalizeAppointmentStatus,
    DOCTOR_APPOINTMENT_SELECT,
    getDoctorAppointmentById,
    getConsultationAggregateByAppointmentId,
    getMedicalPricingAggregateByConsultationId,
    enrichAppointmentChainWithConsultationData,
    getConsultationHistoryRows,
} = require('./shared');
    const { parsePagination, resolvePagination, buildPaginationMeta } = require('../../../utils/pagination');
const { getAppointmentChain } = require('../../../services/followupService');
const { getMedicationPaymentSummaries } = require('../../../services/billingService');
const {
    buildPlateBlankTimelineRows,
    getActiveProtectedWindowAppointmentIds,
    getSlotQueueContext,
    sortAppointmentsByRuntimeQueue,
} = require('../../../services/liveQueueService');
const { resolveDoctorVisibleSlotId } = require('../../../services/doctorSessionService');

const normalizeQueueDateKey = (value) => {
    if (!value) {
        return '';
    }

    if (value instanceof Date && !Number.isNaN(value.getTime())) {
        return [
            value.getFullYear(),
            String(value.getMonth() + 1).padStart(2, '0'),
            String(value.getDate()).padStart(2, '0'),
        ].join('-');
    }

    const stringValue = String(value).trim();
    return stringValue.includes('T') ? stringValue.split('T')[0] : stringValue.slice(0, 10);
};

const listAppointmentsForDoctor = asyncHandler(async (req, res) => {
    const branchId = req.query.branch_id !== undefined ? toPositiveInt(req.query.branch_id) : null;
    const appointmentDate = req.query.appointment_date ? String(req.query.appointment_date).trim() : null;
    const status = req.query.status ? normalizeAppointmentStatus(req.query.status) : null;
    const patientSearch = req.query.patient_search ? String(req.query.patient_search).trim() : null;
    const includeConsulted = String(req.query.include_consulted || '').trim().toLowerCase() === 'true';

    if (req.query.branch_id !== undefined && !branchId) {
        throw new AppError('branch_id must be a positive integer', 400);
    }
    if (appointmentDate && !isValidDateString(appointmentDate)) {
        throw new AppError('appointment_date must be in YYYY-MM-DD format', 400);
    }
    if (req.query.status && !status) {
        throw new AppError('status must be one of Pending, Confirmed, Completed or Cancelled', 400);
    }

    const today = new Date();
    const todayDateString = [
        today.getFullYear(),
        String(today.getMonth() + 1).padStart(2, '0'),
        String(today.getDate()).padStart(2, '0'),
    ].join('-');

    const conditions = [];
    const params = [];

    conditions.push('a.is_active = 1');
    conditions.push(`a.status <> 'Cancelled'`);

    if (branchId) {
        conditions.push('a.fk_branch_id = ?');
        params.push(branchId);
    }
    if (appointmentDate) {
        conditions.push('a.appointment_date = ?');
        params.push(appointmentDate);
    }
    if (status) {
        conditions.push('a.status = ?');
        params.push(status);
    }
    if (patientSearch) {
        conditions.push('(p.full_name LIKE ? OR p.mobile_no LIKE ? OR p.uuid LIKE ?)');
        params.push(`%${patientSearch}%`, `%${patientSearch}%`, `%${patientSearch}%`);
    }

    if (!appointmentDate) {
        conditions.push('a.appointment_date >= CURDATE()');
    }
    if (!includeConsulted && (!appointmentDate || appointmentDate >= todayDateString) && status !== 'Completed') {
        conditions.push('c.id IS NULL');
    }

    const shouldResolveVisibleSlot = Boolean(branchId && appointmentDate && appointmentDate === todayDateString);
    const resolvedVisibleSlotId = shouldResolveVisibleSlot
        ? await resolveDoctorVisibleSlotId({
            doctorId: req.user?.id || null,
            branchId,
            appointmentDate,
        })
        : null;

    if (shouldResolveVisibleSlot) {
        if (resolvedVisibleSlotId) {
            conditions.push('a.fk_slot_id = ?');
            params.push(resolvedVisibleSlotId);
        } else {
            conditions.push('1 = 0');
        }
    }

    const appointments = await query(
        `${DOCTOR_APPOINTMENT_SELECT}
         WHERE ${conditions.join(' AND ')}
         ORDER BY a.appointment_date DESC, a.current_token_number ASC, a.created_at DESC`,
        params
    );
    const queueGroups = appointments.reduce((groups, appointment) => {
        if (!appointment?.appointment_date || !appointment?.fk_branch_id || !appointment?.fk_slot_id) {
            return groups;
        }

        groups.set(
            [
                normalizeQueueDateKey(appointment.appointment_date),
                Number(appointment.fk_branch_id),
                Number(appointment.fk_slot_id),
            ].join(':'),
            {
                appointment_date: appointment.appointment_date,
                fk_branch_id: Number(appointment.fk_branch_id),
                fk_slot_id: Number(appointment.fk_slot_id),
            }
        );

        return groups;
    }, new Map());
    let queueSessions = [];
    let queueTimelineRows = [];
    const protectedWindowAppointmentIdsByGroup = new Map();

    if (queueGroups.size > 0) {
        const groupConditions = [];
        const groupParams = [];

        for (const group of queueGroups.values()) {
            groupConditions.push('(appointment_date = ? AND fk_branch_id = ? AND fk_slot_id = ?)');
            groupParams.push(group.appointment_date, group.fk_branch_id, group.fk_slot_id);
        }

        queueSessions = await query(
            `SELECT fk_branch_id, fk_slot_id, appointment_date, session_status, current_appointment_id
             FROM tbl_live_queue_sessions
             WHERE ${groupConditions.join(' OR ')}`,
            groupParams
        );

        queueTimelineRows = await query(
            `SELECT
                appointment_id,
                fk_branch_id,
                fk_slot_id,
                appointment_date,
                current_token_number AS token_number,
                original_token_number,
                current_token_number,
                queue_status,
                checked_in_at,
                arrival_sequence,
                actual_called_at,
                actual_started_at,
                actual_completed_at,
                planned_start_at,
                live_estimated_start_at
             FROM tbl_appointments
             WHERE is_active = 1
               AND status <> 'Cancelled'
               AND (${groupConditions.join(' OR ')})
             ORDER BY appointment_date ASC, fk_branch_id ASC, fk_slot_id ASC, current_token_number ASC, created_at ASC`,
            groupParams
        );

        const blankTimelineRows = [];
        for (const group of queueGroups.values()) {
            const slot = await getSlotQueueContext({
                slotId: group.fk_slot_id,
                branchId: group.fk_branch_id,
                appointmentDate: normalizeQueueDateKey(group.appointment_date),
            });
            const groupTimelineRows = queueTimelineRows.filter((row) => (
                normalizeQueueDateKey(row.appointment_date) === slot.appointmentDate
                && Number(row.fk_branch_id) === slot.branchId
                && Number(row.fk_slot_id) === slot.slotId
            ));

            blankTimelineRows.push(...await buildPlateBlankTimelineRows({
                execute: query,
                branchId: slot.branchId,
                slotId: slot.slotId,
                appointmentDate: slot.appointmentDate,
                slotStartTime: slot.slotStartTime,
                timelineRows: groupTimelineRows,
            }));

            const protectedWindowAppointmentIds = await getActiveProtectedWindowAppointmentIds(query, {
                branchId: slot.branchId,
                slotId: slot.slotId,
                appointmentDate: slot.appointmentDate,
            });

            if (protectedWindowAppointmentIds.length > 0) {
                protectedWindowAppointmentIdsByGroup.set(
                    [slot.appointmentDate, slot.branchId, slot.slotId].join(':'),
                    protectedWindowAppointmentIds
                );
            }
        }

        queueTimelineRows = [
            ...queueTimelineRows,
            ...blankTimelineRows,
        ];
    }

    return res.status(200).json({
        success: true,
        message: 'Doctor appointments fetched successfully',
        data: sortAppointmentsByRuntimeQueue(appointments, {
            sessions: queueSessions,
            timelineRows: queueTimelineRows,
            protectedWindowAppointmentIdsByGroup,
        }),
        meta: {
            filters: {
                branch_id: branchId,
                resolved_slot_id: resolvedVisibleSlotId,
                appointment_date: appointmentDate,
                status,
                patient_search: patientSearch,
                include_consulted: includeConsulted,
            },
            total: appointments.length,
        },
    });
});

const listConsultationHistoryForDoctor = asyncHandler(async (req, res) => {
    const branchId = req.query.branch_id !== undefined ? toPositiveInt(req.query.branch_id) : null;
    const fromDate = req.query.from_date ? String(req.query.from_date).trim() : null;
    const toDate = req.query.to_date ? String(req.query.to_date).trim() : null;
    const patientSearch = req.query.patient_search ? String(req.query.patient_search).trim() : null;

    const status = req.query.status ? String(req.query.status).trim() : null;

    if (req.query.branch_id !== undefined && !branchId) {
        throw new AppError('branch_id must be a positive integer', 400);
    }
    if (fromDate && !isValidDateString(fromDate)) {
        throw new AppError('from_date must be in YYYY-MM-DD format', 400);
    }
    if (toDate && !isValidDateString(toDate)) {
        throw new AppError('to_date must be in YYYY-MM-DD format', 400);
    }

    const { page, pageSize } = parsePagination(req.query);
    const { rows: consultationRows, pagination } = await getConsultationHistoryRows({
        branchId,
        fromDate,
        toDate,
        patientSearch,
        status,
        page,
        pageSize,
    });

    const data = await Promise.all(
        consultationRows.map(async (row) => ({
            appointment: {
                appointment_id: row.appointment_id,
                auid: row.auid,
                fk_patient_id: row.fk_patient_id,
                parent_appointment_id: row.parent_appointment_id,
                fk_branch_id: row.fk_branch_id,
                branch_name: row.branch_name,
                fk_treatment_id: row.fk_treatment_id,
                treatment_name: row.treatment_name,
                fk_slot_id: row.fk_slot_id,
                slot_name: row.slot_name,
                start_time: row.start_time,
                end_time: row.end_time,
                ...decorateTokenFields({
                    slot_name: row.slot_name,
                    start_time: row.start_time,
                    token_number: row.token_number,
                }),
                appointment_date: row.appointment_date,
                symptoms: row.appointment_symptoms,
                status: row.appointment_status,
                cancelled_at: row.cancelled_at,
                cancelled_by_user_id: row.cancelled_by_user_id,
                cancelled_by_role: row.cancelled_by_role,
                cancel_reason: row.cancel_reason,
                is_active: row.is_active,
                created_at: row.appointment_created_at,
                updated_at: row.appointment_updated_at,
                patient_id: row.patient_id,
                patient_uuid: row.patient_uuid,
                patient_full_name: row.patient_full_name,
                patient_age: row.patient_age,
                patient_gender: row.patient_gender,
                patient_email: row.patient_email,
                patient_mobile_no: row.patient_mobile_no,
                patient_description: row.patient_description,
                booked_for_type: row.booked_for_type,
                fk_patient_family_member_id: row.fk_patient_family_member_id,
                family_member_relationship: row.family_member_relationship,
                primary_patient_full_name: row.primary_patient_full_name,
            },
            consultation: await getConsultationAggregateByAppointmentId(row.appointment_id),
            pricing: await getMedicalPricingAggregateByConsultationId(row.consultation_id),
            follow_up_chain: await enrichAppointmentChainWithConsultationData(
                await getAppointmentChain(row.appointment_id)
            ),
        }))
    );

    const paymentSummaries = await getMedicationPaymentSummaries({
        consultationIds: consultationRows.map((row) => Number(row.consultation_id)).filter(Boolean),
    });
    data.forEach((item, index) => {
        item.payment_summary = paymentSummaries.byConsultationId.get(Number(consultationRows[index].consultation_id))
            || { cash_amount: 0, online_amount: 0, payment_mode: null };
    });

    return res.status(200).json({
        success: true,
        message: 'Doctor consultation history fetched successfully',
        data,
        meta: {
            ...buildPaginationMeta(pagination),
            filters: {
                branch_id: branchId,
                from_date: fromDate,
                to_date: toDate,
                patient_search: patientSearch,
                status: status || 'all',
            },
            total: pagination.total,
        },
    });
});

const listBilledPrescriptionsForDoctor = asyncHandler(async (req, res) => {
    const branchId = req.query.branch_id !== undefined ? toPositiveInt(req.query.branch_id) : null;
    const fromDate = req.query.from_date ? String(req.query.from_date).trim() : null;
    const toDate = req.query.to_date ? String(req.query.to_date).trim() : null;
    const patientSearch = req.query.patient_search ? String(req.query.patient_search).trim() : null;

    if (req.query.branch_id !== undefined && !branchId) {
        throw new AppError('branch_id must be a positive integer', 400);
    }
    if (fromDate && !isValidDateString(fromDate)) {
        throw new AppError('from_date must be in YYYY-MM-DD format', 400);
    }
    if (toDate && !isValidDateString(toDate)) {
        throw new AppError('to_date must be in YYYY-MM-DD format', 400);
    }

    const conditions = ['mpp.id IS NOT NULL'];
    const params = [];

    if (branchId) {
        conditions.push('a.fk_branch_id = ?');
        params.push(branchId);
    }
    if (fromDate) {
        conditions.push('a.appointment_date >= ?');
        params.push(fromDate);
    }
    if (toDate) {
        conditions.push('a.appointment_date <= ?');
        params.push(toDate);
    }
    if (patientSearch) {
        conditions.push('(p.full_name LIKE ? OR p.mobile_no LIKE ? OR p.uuid LIKE ?)');
        params.push(`%${patientSearch}%`, `%${patientSearch}%`, `%${patientSearch}%`);
    }

    const { page, pageSize } = parsePagination(req.query);
    const whereClause = `WHERE ${conditions.join(' AND ')}`;
    const fromSql = `FROM tbl_consultations c
         JOIN tbl_appointments a ON a.appointment_id = c.appointment_id
         JOIN master_clinic_branches b ON b.id = a.fk_branch_id
         JOIN master_treatments t ON t.id = a.fk_treatment_id
         JOIN master_slots s ON s.id = a.fk_slot_id
         LEFT JOIN tbl_doctor_slot_time_overrides sto
           ON sto.fk_branch_id = a.fk_branch_id
          AND sto.fk_slot_id = a.fk_slot_id
          AND sto.appointment_date = a.appointment_date
          AND sto.status = 'ACTIVE'
         ${getAppointmentPatientJoin()}
         JOIN tbl_medical_prescription_pricing mpp ON mpp.consultation_id = c.id
         ${whereClause}`;

    const countRows = await query(`SELECT COUNT(*) AS total ${fromSql}`, params);
    const pagination = resolvePagination({
        page,
        pageSize,
        total: Number(countRows[0]?.total || 0),
    });

    const rows = await query(
        `SELECT
            c.id AS consultation_id,
            c.appointment_id,
            c.doctor_id,
            c.workflow_status,
            c.medication_duration_days,
            c.symptoms AS consultation_symptoms,
            c.treatment_advice,
            c.created_at AS consultation_created_at,
            c.updated_at AS consultation_updated_at,
            a.auid,
            a.fk_patient_id,
            a.fk_branch_id,
            b.branch_name,
            a.fk_treatment_id,
            t.treatment_name,
            a.fk_slot_id,
            s.slot_name,
            COALESCE(sto.override_start_time, s.start_time) AS start_time,
            COALESCE(sto.override_end_time, s.end_time) AS end_time,
            a.current_token_number AS token_number,
            a.original_token_number,
            a.current_token_number,
            a.appointment_date,
            a.status AS appointment_status,
            a.is_active,
            ${getAppointmentPatientColumns()},
            mpp.id AS pricing_id,
            mpp.total_amount,
            mpp.remark AS pricing_remark,
            mpp.created_at AS pricing_created_at,
            mpp.updated_at AS pricing_updated_at
         ${fromSql}
         ORDER BY mpp.updated_at DESC, c.id DESC
         LIMIT ${pagination.pageSize} OFFSET ${pagination.offset}`,
        params
    );

    const data = await Promise.all(
        rows.map(async (row) => ({
            appointment: {
                appointment_id: row.appointment_id,
                auid: row.auid,
                fk_patient_id: row.fk_patient_id,
                fk_branch_id: row.fk_branch_id,
                branch_name: row.branch_name,
                fk_treatment_id: row.fk_treatment_id,
                treatment_name: row.treatment_name,
                fk_slot_id: row.fk_slot_id,
                slot_name: row.slot_name,
                start_time: row.start_time,
                end_time: row.end_time,
                ...decorateTokenFields({
                    slot_name: row.slot_name,
                    start_time: row.start_time,
                    token_number: row.token_number,
                    original_token_number: row.original_token_number,
                    current_token_number: row.current_token_number,
                }),
                appointment_date: row.appointment_date,
                status: row.appointment_status,
                is_active: row.is_active,
                patient_id: row.patient_id,
                patient_uuid: row.patient_uuid,
                patient_full_name: row.patient_full_name,
                patient_age: row.patient_age,
                patient_gender: row.patient_gender,
                patient_email: row.patient_email,
                patient_mobile_no: row.patient_mobile_no,
                patient_description: row.patient_description,
            },
            consultation: await getConsultationAggregateByAppointmentId(row.appointment_id),
            pricing: await getMedicalPricingAggregateByConsultationId(row.consultation_id),
        }))
    );

    return res.status(200).json({
        success: true,
        message: 'Doctor billed prescriptions fetched successfully',
        data,
        meta: {
            ...buildPaginationMeta(pagination),
            filters: {
                branch_id: branchId,
                from_date: fromDate,
                to_date: toDate,
                patient_search: patientSearch,
            },
            total: pagination.total,
        },
    });
});

const getAppointmentDetailForDoctor = asyncHandler(async (req, res) => {
    const appointmentId = toPositiveInt(req.params.appointment_id);

    if (!appointmentId) {
        throw new AppError('Valid appointment_id is required', 400);
    }

    const appointment = await getDoctorAppointmentById(appointmentId, req.selectedBranchId || null);
    if (!appointment) {
        throw new AppError('Appointment not found', 404);
    }

    const consultation = await getConsultationAggregateByAppointmentId(appointmentId);
    const followUpChain = await enrichAppointmentChainWithConsultationData(
        await getAppointmentChain(appointmentId)
    );

    return res.status(200).json({
        success: true,
        message: 'Appointment detail fetched successfully',
        data: {
            ...appointment,
            consultation,
            follow_up_chain: followUpChain,
        },
    });
});

module.exports = {
    listAppointmentsForDoctor,
    listConsultationHistoryForDoctor,
    listBilledPrescriptionsForDoctor,
    getAppointmentDetailForDoctor,
};
