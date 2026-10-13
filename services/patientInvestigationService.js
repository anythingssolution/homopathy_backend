const AppError = require('../utils/AppError');

const INVESTIGATION_TYPES = new Set([
    'X_RAY',
    'SONOGRAPHY',
    'CT_SCAN',
    'MRI',
    'PET_CT',
    'BLOOD_INVESTIGATION',
    'OTHER',
]);

const INVESTIGATION_STATUSES = new Set([
    'ADVISED',
    'DONE',
    'REPORT_SEEN',
    'NOT_AVAILABLE',
]);

const toPositiveInt = (value) => {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

const toNullableText = (value, maxLength = 5000) => {
    if (value === undefined || value === null) {
        return null;
    }

    const normalized = String(value).trim();
    return normalized ? normalized.slice(0, maxLength) : null;
};

const isValidDateString = (value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));

const normalizeInvestigationType = (value) => {
    const normalized = String(value || '').trim().toUpperCase();
    const aliases = {
        XRAY: 'X_RAY',
        'X-RAY': 'X_RAY',
        X_RAY: 'X_RAY',
        SONOGRAPHY: 'SONOGRAPHY',
        USG: 'SONOGRAPHY',
        CT: 'CT_SCAN',
        'CT-SCAN': 'CT_SCAN',
        CT_SCAN: 'CT_SCAN',
        MRI: 'MRI',
        PET: 'PET_CT',
        PETCT: 'PET_CT',
        'PET-CT': 'PET_CT',
        PET_CT: 'PET_CT',
        BLOOD: 'BLOOD_INVESTIGATION',
        BLOOD_INVESTIGATION: 'BLOOD_INVESTIGATION',
        OTHER: 'OTHER',
    };

    return aliases[normalized] || normalized;
};

const normalizeInvestigationStatus = (value) => {
    const normalized = String(value || '').trim().toUpperCase();
    const aliases = {
        ADVISED: 'ADVISED',
        PENDING: 'ADVISED',
        DONE: 'DONE',
        COMPLETED: 'DONE',
        REPORT_SEEN: 'REPORT_SEEN',
        SEEN: 'REPORT_SEEN',
        NOT_AVAILABLE: 'NOT_AVAILABLE',
        NA: 'NOT_AVAILABLE',
    };

    return aliases[normalized] || 'DONE';
};

const normalizeInvestigationPayload = (items = []) => {
    if (!Array.isArray(items)) {
        throw new AppError('Investigations must be a list', 400);
    }

    return items
        .map((item, index) => {
            const type = normalizeInvestigationType(item?.investigation_type ?? item?.type);
            const status = normalizeInvestigationStatus(item?.status);
            const id = toPositiveInt(item?.id ?? item?.investigation_id);
            const testName = toNullableText(item?.test_name ?? item?.testName, 255);
            const investigationDate = toNullableText(item?.investigation_date ?? item?.investigationDate, 10);
            const findings = toNullableText(item?.findings);
            const reportReference = toNullableText(item?.report_reference ?? item?.reportReference, 255);
            const documentId = toPositiveInt(item?.document_id ?? item?.documentId);
            const hasContent = Boolean(id || testName || investigationDate || findings || reportReference || documentId);

            if (!hasContent) {
                return null;
            }
            if (!INVESTIGATION_TYPES.has(type)) {
                throw new AppError(`Invalid investigation type at row ${index + 1}`, 400);
            }
            if (!INVESTIGATION_STATUSES.has(status)) {
                throw new AppError(`Invalid investigation status at row ${index + 1}`, 400);
            }
            if (investigationDate && !isValidDateString(investigationDate)) {
                throw new AppError(`Investigation date must be YYYY-MM-DD at row ${index + 1}`, 400);
            }

            return {
                id,
                investigation_type: type,
                test_name: testName,
                investigation_date: investigationDate,
                status,
                findings,
                report_reference: reportReference,
                document_id: documentId,
            };
        })
        .filter(Boolean);
};

const normalizeRows = (result) => {
    if (Array.isArray(result?.[0])) {
        return result[0];
    }
    return Array.isArray(result) ? result : [];
};

const runRows = async (execute, sql, params = []) => normalizeRows(await execute(sql, params));

const listInvestigationsByAppointmentId = async (execute, appointmentId) => {
    const rows = await runRows(
        execute,
        `SELECT
            id,
            appointment_id,
            consultation_id,
            patient_id,
            family_member_id,
            fk_branch_id,
            doctor_id,
            investigation_type,
            test_name,
            investigation_date,
            status,
            findings,
            report_reference,
            document_id,
            created_by_role,
            created_by_user_id,
            updated_by_role,
            updated_by_user_id,
            created_at,
            updated_at
         FROM tbl_patient_investigations
         WHERE appointment_id = ?
           AND is_active = 1
         ORDER BY COALESCE(investigation_date, DATE(created_at)) DESC, id ASC`,
        [appointmentId]
    );

    return rows.map((row) => ({
        ...row,
        id: Number(row.id),
        appointment_id: Number(row.appointment_id),
        consultation_id: row.consultation_id ? Number(row.consultation_id) : null,
        patient_id: Number(row.patient_id),
        family_member_id: row.family_member_id ? Number(row.family_member_id) : null,
        fk_branch_id: Number(row.fk_branch_id),
        doctor_id: row.doctor_id ? Number(row.doctor_id) : null,
        document_id: row.document_id ? Number(row.document_id) : null,
    }));
};

const listInvestigationsByAppointmentIds = async (execute, appointmentIds = []) => {
    const normalizedIds = [...new Set(
        appointmentIds
            .map((appointmentId) => toPositiveInt(appointmentId))
            .filter(Boolean)
    )];
    if (normalizedIds.length === 0) {
        return new Map();
    }

    const placeholders = normalizedIds.map(() => '?').join(', ');
    const rows = await runRows(
        execute,
        `SELECT
            id,
            appointment_id,
            consultation_id,
            patient_id,
            family_member_id,
            fk_branch_id,
            doctor_id,
            investigation_type,
            test_name,
            investigation_date,
            status,
            findings,
            report_reference,
            document_id,
            created_by_role,
            created_by_user_id,
            updated_by_role,
            updated_by_user_id,
            created_at,
            updated_at
         FROM tbl_patient_investigations
         WHERE appointment_id IN (${placeholders})
           AND is_active = 1
         ORDER BY appointment_id ASC, COALESCE(investigation_date, DATE(created_at)) DESC, id ASC`,
        normalizedIds
    );

    const grouped = new Map();
    rows.forEach((row) => {
        const appointmentId = Number(row.appointment_id);
        const item = {
            ...row,
            id: Number(row.id),
            appointment_id: appointmentId,
            consultation_id: row.consultation_id ? Number(row.consultation_id) : null,
            patient_id: Number(row.patient_id),
            family_member_id: row.family_member_id ? Number(row.family_member_id) : null,
            fk_branch_id: Number(row.fk_branch_id),
            doctor_id: row.doctor_id ? Number(row.doctor_id) : null,
            document_id: row.document_id ? Number(row.document_id) : null,
        };
        grouped.set(appointmentId, [...(grouped.get(appointmentId) || []), item]);
    });

    return grouped;
};

const getAppointmentScope = async (execute, appointmentId) => {
    const rows = await runRows(
        execute,
        `SELECT
            appointment_id,
            fk_patient_id,
            fk_patient_family_member_id,
            fk_branch_id,
            status,
            is_active
         FROM tbl_appointments
         WHERE appointment_id = ?
         LIMIT 1
         FOR UPDATE`,
        [appointmentId]
    );

    return rows[0] || null;
};

const replaceAppointmentInvestigations = async (
    execute,
    {
        appointmentId,
        consultationId = null,
        doctorId = null,
        actorRole = null,
        actorUserId = null,
        investigations = [],
        appointmentScope = null,
    }
) => {
    const normalizedInvestigations = normalizeInvestigationPayload(investigations);
    const scope = appointmentScope || await getAppointmentScope(execute, appointmentId);
    if (!scope) {
        throw new AppError('Appointment not found for investigations', 404);
    }
    if (Number(scope.is_active) !== 1 || String(scope.status || '') === 'Cancelled') {
        throw new AppError('Investigations cannot be updated for a cancelled or inactive appointment', 409);
    }

    const activeRows = await runRows(
        execute,
        `SELECT id FROM tbl_patient_investigations WHERE appointment_id = ? AND is_active = 1`,
        [appointmentId]
    );
    const activeIds = new Set(activeRows.map((row) => Number(row.id)));
    const keptIds = [];

    for (const investigation of normalizedInvestigations) {
        if (investigation.id && activeIds.has(investigation.id)) {
            await execute(
                `UPDATE tbl_patient_investigations
                 SET consultation_id = COALESCE(?, consultation_id),
                     doctor_id = COALESCE(?, doctor_id),
                     investigation_type = ?,
                     test_name = ?,
                     investigation_date = ?,
                     status = ?,
                     findings = ?,
                     report_reference = ?,
                     document_id = ?,
                     updated_by_role = ?,
                     updated_by_user_id = ?,
                     updated_at = NOW()
                 WHERE id = ?
                   AND appointment_id = ?
                   AND is_active = 1`,
                [
                    consultationId,
                    doctorId,
                    investigation.investigation_type,
                    investigation.test_name,
                    investigation.investigation_date,
                    investigation.status,
                    investigation.findings,
                    investigation.report_reference,
                    investigation.document_id,
                    actorRole,
                    actorUserId,
                    investigation.id,
                    appointmentId,
                ]
            );
            keptIds.push(investigation.id);
        } else {
            const result = await execute(
                `INSERT INTO tbl_patient_investigations
                 (appointment_id, consultation_id, patient_id, family_member_id, fk_branch_id, doctor_id,
                  investigation_type, test_name, investigation_date, status, findings, report_reference, document_id,
                  created_by_role, created_by_user_id, updated_by_role, updated_by_user_id)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    appointmentId,
                    consultationId,
                    scope.fk_patient_id,
                    scope.fk_patient_family_member_id || null,
                    scope.fk_branch_id,
                    doctorId,
                    investigation.investigation_type,
                    investigation.test_name,
                    investigation.investigation_date,
                    investigation.status,
                    investigation.findings,
                    investigation.report_reference,
                    investigation.document_id,
                    actorRole,
                    actorUserId,
                    actorRole,
                    actorUserId,
                ]
            );
            keptIds.push(Number(result?.[0]?.insertId || result?.insertId || 0));
        }
    }

    const idsToDeactivate = Array.from(activeIds).filter((id) => !keptIds.includes(id));
    if (idsToDeactivate.length > 0) {
        const placeholders = idsToDeactivate.map(() => '?').join(', ');
        await execute(
            `UPDATE tbl_patient_investigations
             SET is_active = 0,
                 updated_by_role = ?,
                 updated_by_user_id = ?,
                 updated_at = NOW()
             WHERE appointment_id = ?
               AND id IN (${placeholders})`,
            [actorRole, actorUserId, appointmentId, ...idsToDeactivate]
        );
    }

    if (consultationId) {
        await linkAppointmentInvestigationsToConsultation(execute, {
            appointmentId,
            consultationId,
            doctorId,
            actorRole,
            actorUserId,
        });
    }

    return listInvestigationsByAppointmentId(execute, appointmentId);
};

const linkAppointmentInvestigationsToConsultation = async (
    execute,
    {
        appointmentId,
        consultationId,
        doctorId = null,
        actorRole = null,
        actorUserId = null,
    }
) => {
    await execute(
        `UPDATE tbl_patient_investigations
         SET consultation_id = ?,
             doctor_id = COALESCE(?, doctor_id),
             updated_by_role = ?,
             updated_by_user_id = ?,
             updated_at = NOW()
         WHERE appointment_id = ?
           AND is_active = 1`,
        [consultationId, doctorId, actorRole, actorUserId, appointmentId]
    );
};

module.exports = {
    INVESTIGATION_TYPES,
    INVESTIGATION_STATUSES,
    normalizeInvestigationPayload,
    listInvestigationsByAppointmentId,
    listInvestigationsByAppointmentIds,
    replaceAppointmentInvestigations,
    linkAppointmentInvestigationsToConsultation,
};
