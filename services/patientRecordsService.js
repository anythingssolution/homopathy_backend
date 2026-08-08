const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { env } = require('../config/env');
const { query, withTransaction } = require('../config/db');
const AppError = require('../utils/AppError');
const { buildSafeFilename } = require('../utils/fileNaming');
const { validateClinicalDocumentUpload } = require('../utils/uploadValidation');

const DOCUMENT_TYPES = new Set([
    'CASE_PAPER',
    'LAB_REPORT',
    'IMAGING',
    'PRESCRIPTION',
    'BILL',
    'OTHER',
]);

const DOCUMENT_STATUSES = new Set(['ACTIVE', 'ARCHIVED', 'DELETED']);
const TIMELINE_TYPES = new Set(['APPOINTMENT', 'CONSULTATION', 'PRESCRIPTION', 'BILL', 'DOCUMENT']);
const DEFAULT_DOCUMENT_STORAGE_ROOT = path.resolve(__dirname, '..', 'external_files', 'clinical-documents');

const toPositiveInt = (value) => {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

const isValidDateString = (value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));

const normalizeDateFilter = (value, label) => {
    if (value === undefined || value === null || value === '') {
        return null;
    }

    const normalized = String(value).trim();
    if (!isValidDateString(normalized)) {
        throw new AppError(`${label} must be in YYYY-MM-DD format`, 400);
    }

    return normalized;
};

const normalizeDocumentType = (value, { required = false } = {}) => {
    const normalized = String(value || '').trim().toUpperCase();
    if (!normalized) {
        if (required) {
            throw new AppError('document_type is required', 400);
        }

        return null;
    }

    if (!DOCUMENT_TYPES.has(normalized)) {
        throw new AppError(`document_type must be one of: ${Array.from(DOCUMENT_TYPES).join(', ')}`, 400);
    }

    return normalized;
};

const normalizeDocumentStatus = (value) => {
    const normalized = String(value || '').trim().toUpperCase();
    if (!normalized) {
        return 'ACTIVE';
    }

    if (!DOCUMENT_STATUSES.has(normalized)) {
        throw new AppError(`document_status must be one of: ${Array.from(DOCUMENT_STATUSES).join(', ')}`, 400);
    }

    return normalized;
};

const normalizeTimelineType = (value) => {
    const normalized = String(value || '').trim().toUpperCase();
    if (!normalized) {
        return null;
    }

    if (!TIMELINE_TYPES.has(normalized)) {
        throw new AppError(`timeline_type must be one of: ${Array.from(TIMELINE_TYPES).join(', ')}`, 400);
    }

    return normalized;
};

const normalizeSubjectScope = (value) => {
    const normalized = String(value || '').trim().toUpperCase();
    if (!normalized) {
        return 'ALL';
    }

    if (!['ALL', 'SELF', 'FAMILY_MEMBER'].includes(normalized)) {
        throw new AppError('subject_scope must be one of: ALL, SELF, FAMILY_MEMBER', 400);
    }

    return normalized;
};

const getClientIp = (req) => {
    const forwarded = req.headers?.['x-forwarded-for'];
    if (forwarded) {
        return String(forwarded).split(',')[0].trim();
    }

    return req.ip || req.socket?.remoteAddress || '0.0.0.0';
};

const getClinicalDocumentStorageRoot = () => (
    process.env.CLINICAL_DOCUMENT_STORAGE_ROOT
        ? path.resolve(process.env.CLINICAL_DOCUMENT_STORAGE_ROOT)
        : DEFAULT_DOCUMENT_STORAGE_ROOT
);

const safeJsonParse = (value, fallback = null) => {
    if (value === undefined || value === null) {
        return fallback;
    }

    if (typeof value === 'object') {
        return value;
    }

    try {
        return JSON.parse(value);
    } catch (_error) {
        return fallback;
    }
};

const normalizeText = (value, maxLength = 255) => {
    if (value === undefined || value === null) {
        return null;
    }

    const normalized = String(value).trim();
    return normalized ? normalized.slice(0, maxLength) : null;
};

const buildSubject = (row) => {
    const isFamilyBooking = Number(row.is_family_member_booking || 0) === 1 && row.fk_patient_family_member_id;

    return {
        subject_type: isFamilyBooking ? 'FAMILY_MEMBER' : 'SELF',
        patient_id: row.patient_id ? Number(row.patient_id) : null,
        patient_uuid: row.patient_uuid || null,
        primary_patient_full_name: row.primary_patient_full_name || null,
        primary_patient_mobile_no: row.primary_patient_mobile_no || row.patient_mobile_no || null,
        family_member_id: isFamilyBooking ? Number(row.fk_patient_family_member_id) : null,
        family_member_relationship: isFamilyBooking ? row.family_member_relationship || null : null,
        relationship_label: isFamilyBooking ? row.family_member_relationship || 'Family Member' : 'Self',
        display_name: row.patient_full_name || row.primary_patient_full_name || null,
        age: row.patient_age || null,
        gender: row.patient_gender || null,
    };
};

const appendCommonFilters = ({ conditions, params, filters, aliases = {} }) => {
    const {
        appointmentAlias = 'a',
        consultationAlias = 'c',
        patientAlias = 'p',
        familyAlias = 'fm',
        eventDateExpression = `${appointmentAlias}.appointment_date`,
    } = aliases;

    conditions.push(`${appointmentAlias}.fk_branch_id = ?`);
    params.push(filters.branchId);

    if (filters.fromDate) {
        conditions.push(`DATE(${eventDateExpression}) >= ?`);
        params.push(filters.fromDate);
    }

    if (filters.toDate) {
        conditions.push(`DATE(${eventDateExpression}) <= ?`);
        params.push(filters.toDate);
    }

    if (filters.patientId) {
        conditions.push(`${appointmentAlias}.fk_patient_id = ?`);
        params.push(filters.patientId);
    }

    if (filters.familyMemberId) {
        conditions.push(`${appointmentAlias}.fk_patient_family_member_id = ?`);
        params.push(filters.familyMemberId);
    }

    if (filters.subjectScope === 'SELF') {
        conditions.push(`(${appointmentAlias}.booked_for_type <> 'FAMILY_MEMBER' OR ${appointmentAlias}.fk_patient_family_member_id IS NULL)`);
    }

    if (filters.doctorId) {
        conditions.push(`${consultationAlias}.doctor_id = ?`);
        params.push(filters.doctorId);
    }

    if (filters.patientSearch) {
        conditions.push(`(
            ${patientAlias}.full_name LIKE ?
            OR ${patientAlias}.mobile_no LIKE ?
            OR ${patientAlias}.uuid LIKE ?
            OR ${familyAlias}.full_name LIKE ?
            OR ${familyAlias}.relationship LIKE ?
            OR ${appointmentAlias}.auid LIKE ?
        )`);
        params.push(
            `%${filters.patientSearch}%`,
            `%${filters.patientSearch}%`,
            `%${filters.patientSearch}%`,
            `%${filters.patientSearch}%`,
            `%${filters.patientSearch}%`,
            `%${filters.patientSearch}%`
        );
    }
};

const parsePageFilters = (rawFilters = {}, defaults = {}) => {
    const page = toPositiveInt(rawFilters.page) || defaults.page || 1;
    const pageSize = Math.min(
        toPositiveInt(rawFilters.page_size) || toPositiveInt(rawFilters.limit) || defaults.pageSize || 20,
        defaults.maxPageSize || 100
    );

    return { page, pageSize };
};

const parseRegistryFilters = (rawFilters = {}, actor = {}) => {
    const branchId = toPositiveInt(rawFilters.branch_id || actor.selected_branch_id);
    if (!branchId) {
        throw new AppError('branch_id is required for patient records', 400);
    }

    const { page, pageSize } = parsePageFilters(rawFilters);

    return {
        branchId,
        patientSearch: normalizeText(rawFilters.patient_search || rawFilters.search, 100),
        page,
        pageSize,
    };
};

const buildRegistryWhere = (filters) => {
    const conditions = [
        'p.role = \'PAT\'',
        'p.is_active = 1',
        'a.is_active = 1',
        'a.status = \'Completed\'',
        'a.fk_branch_id = ?',
    ];
    const params = [filters.branchId];

    if (filters.patientSearch) {
        conditions.push(`(
            p.full_name LIKE ?
            OR p.mobile_no LIKE ?
            OR p.uuid LIKE ?
            OR fm.full_name LIKE ?
            OR fm.relationship LIKE ?
            OR a.auid LIKE ?
        )`);
        params.push(
            `%${filters.patientSearch}%`,
            `%${filters.patientSearch}%`,
            `%${filters.patientSearch}%`,
            `%${filters.patientSearch}%`,
            `%${filters.patientSearch}%`,
            `%${filters.patientSearch}%`
        );
    }

    return {
        whereClause: `WHERE ${conditions.join(' AND ')}`,
        params,
    };
};

const listPatientRegistry = async ({ filters: rawFilters, actor }) => {
    const filters = parseRegistryFilters(rawFilters, actor);
    const { whereClause, params } = buildRegistryWhere(filters);
    const countRows = await query(
        `SELECT COUNT(DISTINCT p.id) AS total
         FROM master_users p
         JOIN tbl_appointments a ON a.fk_patient_id = p.id
         LEFT JOIN tbl_patient_family_members fm ON fm.fk_primary_patient_id = p.id
         ${whereClause}`,
        params
    );

    const total = Number(countRows[0]?.total || 0);
    const totalPages = Math.max(1, Math.ceil(total / filters.pageSize));
    const currentPage = Math.min(filters.page, totalPages);
    const offset = (currentPage - 1) * filters.pageSize;

    const rows = await query(
        `SELECT
            p.id AS patient_id,
            p.uuid AS patient_uuid,
            p.full_name,
            p.age,
            p.gender,
            p.mobile_no,
            p.email,
            p.address,
            p.ward_no,
            p.vidhan_sabha,
            MAX(a.appointment_date) AS latest_visit_date,
            COUNT(DISTINCT a.appointment_id) AS completed_appointments_count,
            COUNT(DISTINCT c.id) AS consultations_count,
            COUNT(DISTINCT CASE
                WHEN COALESCE(med.medicine_count, 0) > 0 OR COALESCE(test.test_count, 0) > 0 THEN c.id
                ELSE NULL
            END) AS prescriptions_count,
            COUNT(DISTINCT bills.id) AS bills_count,
            (
                SELECT COUNT(*)
                FROM tbl_patient_family_members family_count
                WHERE family_count.fk_primary_patient_id = p.id
                  AND family_count.is_active = 1
            ) AS family_members_count
         FROM master_users p
         JOIN tbl_appointments a ON a.fk_patient_id = p.id
         LEFT JOIN tbl_patient_family_members fm ON fm.fk_primary_patient_id = p.id
         LEFT JOIN tbl_consultations c ON c.appointment_id = a.appointment_id
         LEFT JOIN tbl_bills bills ON bills.appointment_id = a.appointment_id AND bills.status = 'ACTIVE'
         LEFT JOIN (
            SELECT consultation_id, COUNT(*) AS medicine_count
            FROM tbl_consultation_medications
            GROUP BY consultation_id
         ) med ON med.consultation_id = c.id
         LEFT JOIN (
            SELECT consultation_id, COUNT(*) AS test_count
            FROM tbl_consultation_tests
            GROUP BY consultation_id
         ) test ON test.consultation_id = c.id
         ${whereClause}
         GROUP BY p.id
         ORDER BY latest_visit_date DESC, p.full_name ASC
         LIMIT ? OFFSET ?`,
        [...params, filters.pageSize, offset]
    );

    return {
        items: rows.map((row) => ({
            patient_id: Number(row.patient_id),
            patient_uuid: row.patient_uuid,
            full_name: row.full_name,
            age: row.age,
            gender: row.gender,
            mobile_no: row.mobile_no,
            email: row.email,
            address: row.address,
            ward_no: row.ward_no,
            vidhan_sabha: row.vidhan_sabha,
            latest_visit_date: row.latest_visit_date,
            summary: {
                completed_appointments_count: Number(row.completed_appointments_count || 0),
                consultations_count: Number(row.consultations_count || 0),
                prescriptions_count: Number(row.prescriptions_count || 0),
                bills_count: Number(row.bills_count || 0),
                family_members_count: Number(row.family_members_count || 0),
            },
        })),
        meta: {
            page: currentPage,
            page_size: filters.pageSize,
            total,
            total_pages: totalPages,
        },
        filters,
    };
};

const getSubjectSummaryRows = async ({ branchId, patientId }) => query(
    `SELECT
        CASE WHEN a.booked_for_type = 'FAMILY_MEMBER' THEN a.fk_patient_family_member_id ELSE 0 END AS subject_id,
        CASE WHEN a.booked_for_type = 'FAMILY_MEMBER' THEN 'FAMILY_MEMBER' ELSE 'SELF' END AS subject_type,
        COUNT(DISTINCT a.appointment_id) AS completed_appointments_count,
        COUNT(DISTINCT c.id) AS consultations_count,
        COUNT(DISTINCT CASE
            WHEN COALESCE(med.medicine_count, 0) > 0 OR COALESCE(test.test_count, 0) > 0 THEN c.id
            ELSE NULL
        END) AS prescriptions_count,
        MAX(a.appointment_date) AS latest_visit_date
     FROM tbl_appointments a
     LEFT JOIN tbl_consultations c ON c.appointment_id = a.appointment_id
     LEFT JOIN (
        SELECT consultation_id, COUNT(*) AS medicine_count
        FROM tbl_consultation_medications
        GROUP BY consultation_id
     ) med ON med.consultation_id = c.id
     LEFT JOIN (
        SELECT consultation_id, COUNT(*) AS test_count
        FROM tbl_consultation_tests
        GROUP BY consultation_id
     ) test ON test.consultation_id = c.id
     WHERE a.fk_branch_id = ?
       AND a.fk_patient_id = ?
       AND a.is_active = 1
       AND a.status = 'Completed'
     GROUP BY subject_type, subject_id`,
    [branchId, patientId]
);

const getPatientRecordDetail = async ({ patientId, actor }) => {
    const branchId = toPositiveInt(actor.selected_branch_id);
    if (!branchId) {
        throw new AppError('branch_id is required for patient records', 400);
    }

    const patientRows = await query(
        `SELECT id AS patient_id,
                uuid AS patient_uuid,
                full_name,
                age,
                gender,
                mobile_no,
                email,
                address,
                ward_no,
                vidhan_sabha
         FROM master_users
         WHERE id = ?
           AND role = 'PAT'
           AND is_active = 1
         LIMIT 1`,
        [patientId]
    );

    if (patientRows.length === 0) {
        throw new AppError('Patient not found', 404);
    }

    const accessRows = await query(
        `SELECT 1
         FROM tbl_appointments
         WHERE fk_patient_id = ?
           AND fk_branch_id = ?
           AND is_active = 1
           AND status = 'Completed'
         LIMIT 1`,
        [patientId, branchId]
    );

    if (accessRows.length === 0) {
        throw new AppError('Patient records not found for selected branch', 404);
    }

    const [familyRows, subjectSummaryRows] = await Promise.all([
        query(
            `SELECT id AS family_member_id,
                    full_name,
                    relationship,
                    age,
                    gender,
                    description,
                    is_active
             FROM tbl_patient_family_members
             WHERE fk_primary_patient_id = ?
               AND is_active = 1
             ORDER BY full_name ASC`,
            [patientId]
        ),
        getSubjectSummaryRows({ branchId, patientId }),
    ]);

    const summaryByKey = new Map(subjectSummaryRows.map((row) => [`${row.subject_type}:${Number(row.subject_id || 0)}`, row]));
    const selfSummary = summaryByKey.get('SELF:0') || {};

    return {
        patient: {
            ...patientRows[0],
            patient_id: Number(patientRows[0].patient_id),
        },
        self: {
            subject_scope: 'SELF',
            label: 'Self',
            summary: {
                completed_appointments_count: Number(selfSummary.completed_appointments_count || 0),
                consultations_count: Number(selfSummary.consultations_count || 0),
                prescriptions_count: Number(selfSummary.prescriptions_count || 0),
                latest_visit_date: selfSummary.latest_visit_date || null,
            },
        },
        family_members: familyRows.map((row) => {
            const summary = summaryByKey.get(`FAMILY_MEMBER:${Number(row.family_member_id)}`) || {};
            return {
                family_member_id: Number(row.family_member_id),
                full_name: row.full_name,
                relationship: row.relationship,
                age: row.age,
                gender: row.gender,
                description: row.description,
                summary: {
                    completed_appointments_count: Number(summary.completed_appointments_count || 0),
                    consultations_count: Number(summary.consultations_count || 0),
                    prescriptions_count: Number(summary.prescriptions_count || 0),
                    latest_visit_date: summary.latest_visit_date || null,
                },
            };
        }),
    };
};

const PATIENT_SELECT = `
    a.booked_for_type,
    a.fk_patient_family_member_id,
    CASE WHEN a.booked_for_type = 'FAMILY_MEMBER' THEN 1 ELSE 0 END AS is_family_member_booking,
    fm.relationship AS family_member_relationship,
    fm.full_name AS family_member_full_name,
    fm.age AS family_member_age,
    fm.gender AS family_member_gender,
    p.id AS patient_id,
    p.uuid AS patient_uuid,
    p.full_name AS primary_patient_full_name,
    p.mobile_no AS primary_patient_mobile_no,
    p.ward_no AS primary_patient_ward_no,
    p.vidhan_sabha AS primary_patient_vidhan_sabha,
    COALESCE(fm.full_name, p.full_name) AS patient_full_name,
    COALESCE(fm.age, p.age) AS patient_age,
    COALESCE(fm.gender, p.gender) AS patient_gender
`;

const fetchAppointmentTimeline = async (filters) => {
    const conditions = ['a.is_active = 1', 'a.status = \'Completed\''];
    const params = [];
    appendCommonFilters({ conditions, params, filters });

    const rows = await query(
        `SELECT
            'APPOINTMENT' AS timeline_type,
            a.appointment_id AS source_id,
            a.appointment_id,
            a.auid,
            a.appointment_date AS event_date,
            a.appointment_date,
            a.current_token_number AS token_number,
            a.status,
            a.reception_status,
            a.queue_status,
            a.fk_branch_id,
            b.branch_name,
            t.treatment_name,
            s.slot_name,
            c.id AS consultation_id,
            c.doctor_id,
            d.full_name AS doctor_full_name,
            ${PATIENT_SELECT}
         FROM tbl_appointments a
         JOIN master_users p ON p.id = a.fk_patient_id
         LEFT JOIN tbl_patient_family_members fm ON fm.id = a.fk_patient_family_member_id
         JOIN master_clinic_branches b ON b.id = a.fk_branch_id
         JOIN master_treatments t ON t.id = a.fk_treatment_id
         JOIN master_slots s ON s.id = a.fk_slot_id
         LEFT JOIN tbl_consultations c ON c.appointment_id = a.appointment_id
         LEFT JOIN master_users d ON d.id = c.doctor_id
         WHERE ${conditions.join(' AND ')}
         ORDER BY a.appointment_date DESC, a.current_token_number ASC`,
        params
    );

    return rows.map((row) => ({
        timeline_type: 'APPOINTMENT',
        source_id: row.source_id,
        event_date: row.event_date,
        title: `Appointment ${row.auid || `#${row.appointment_id}`}`,
        status: row.status,
        branch_id: row.fk_branch_id,
        branch_name: row.branch_name,
        doctor_id: row.doctor_id || null,
        doctor_full_name: row.doctor_full_name || null,
        appointment_id: row.appointment_id,
        consultation_id: row.consultation_id || null,
        bill_id: null,
        document_id: null,
        document_type: null,
        subject: buildSubject(row),
        details: {
            auid: row.auid,
            appointment_date: row.appointment_date,
            token_number: row.token_number,
            treatment_name: row.treatment_name,
            slot_name: row.slot_name,
            reception_status: row.reception_status,
            queue_status: row.queue_status,
            ward_no: row.primary_patient_ward_no || null,
            vidhan_sabha: row.primary_patient_vidhan_sabha || null,
        },
    }));
};

const buildVisitRecord = (row) => ({
    timeline_type: 'VISIT',
    source_id: row.appointment_id,
    event_date: row.appointment_date,
    title: `Visit ${row.auid || `#${row.appointment_id}`}`,
    status: row.status,
    branch_id: row.fk_branch_id,
    branch_name: row.branch_name,
    doctor_id: row.doctor_id || null,
    doctor_full_name: row.doctor_full_name || null,
    appointment_id: row.appointment_id,
    consultation_id: row.consultation_id || null,
    bill_id: row.bill_id || null,
    document_id: null,
    document_type: null,
    subject: buildSubject(row),
    details: {
        auid: row.auid,
        appointment_date: row.appointment_date,
        token_number: row.token_number,
        treatment_name: row.treatment_name,
        slot_name: row.slot_name,
        consultation_status: row.workflow_status || null,
        medication_duration_days: row.medication_duration_days,
        medicine_count: Number(row.medicine_count || 0),
        test_count: Number(row.test_count || 0),
        medicine_summary: row.medicine_summary || null,
        quick_formula_input: row.quick_formula_input || null,
        oxygen_saturation: row.oxygen_saturation || null,
        blood_pressure: row.blood_pressure || null,
        patient_height: row.patient_height || null,
        patient_weight: row.patient_weight || null,
        has_prescription: Boolean(row.consultation_id),
        has_medical_items: Number(row.medicine_count || 0) > 0 || Number(row.test_count || 0) > 0,
        bills_count: Number(row.bills_count || 0),
        bill_number: row.bill_number || null,
        bill_type: row.bill_type || null,
        payment_status: row.payment_status || null,
        total_amount: row.total_amount || null,
        paid_amount: row.paid_amount || null,
        pending_amount: row.pending_amount || null,
        documents_count: Number(row.documents_count || 0),
        document_types: row.document_types || null,
        ward_no: row.primary_patient_ward_no || null,
        vidhan_sabha: row.primary_patient_vidhan_sabha || null,
    },
});

const listPatientVisits = async ({ patientId, filters: rawFilters, actor }) => {
    const branchId = toPositiveInt(rawFilters.branch_id || actor.selected_branch_id);
    if (!branchId) {
        throw new AppError('branch_id is required for patient records', 400);
    }

    const familyMemberId = toPositiveInt(rawFilters.family_member_id);
    const subjectScope = normalizeSubjectScope(rawFilters.subject_scope);

    await assertPatientHistoryScope({
        patientId,
        familyMemberId,
        subjectScope,
        branchId,
    });

    const filters = parseTimelineFilters({
        ...rawFilters,
        branch_id: branchId,
        patient_id: patientId,
        family_member_id: familyMemberId || undefined,
        subject_scope: familyMemberId ? 'FAMILY_MEMBER' : subjectScope,
    }, actor);
    const conditions = ['a.is_active = 1', 'a.status = \'Completed\''];
    const params = [];
    appendCommonFilters({ conditions, params, filters });

    if (filters.timelineType === 'CONSULTATION' || filters.timelineType === 'PRESCRIPTION') {
        conditions.push('c.id IS NOT NULL');
    }

    if (filters.timelineType === 'BILL') {
        conditions.push('COALESCE(bill.bills_count, 0) > 0');
    }

    if (filters.timelineType === 'DOCUMENT') {
        conditions.push('COALESCE(doc.documents_count, 0) > 0');
    }

    const documentTypeJoinFilter = filters.documentType ? 'AND document_type = ?' : '';
    const documentJoinParams = filters.documentType ? [filters.documentType] : [];
    const countParams = [...documentJoinParams, ...params];

    const countRows = await query(
        `SELECT COUNT(DISTINCT a.appointment_id) AS total
         FROM tbl_appointments a
         JOIN master_users p ON p.id = a.fk_patient_id
         LEFT JOIN tbl_patient_family_members fm ON fm.id = a.fk_patient_family_member_id
         LEFT JOIN tbl_consultations c ON c.appointment_id = a.appointment_id
         LEFT JOIN (
            SELECT consultation_id, COUNT(*) AS medicine_count
            FROM tbl_consultation_medications
            GROUP BY consultation_id
         ) med ON med.consultation_id = c.id
         LEFT JOIN (
            SELECT consultation_id, COUNT(*) AS test_count
            FROM tbl_consultation_tests
            GROUP BY consultation_id
         ) test ON test.consultation_id = c.id
         LEFT JOIN (
            SELECT appointment_id, COUNT(DISTINCT id) AS bills_count
            FROM tbl_bills
            WHERE status = 'ACTIVE'
            GROUP BY appointment_id
         ) bill ON bill.appointment_id = a.appointment_id
         LEFT JOIN (
            SELECT appointment_id, COUNT(DISTINCT id) AS documents_count
            FROM tbl_patient_clinical_documents
            WHERE status = 'ACTIVE'
              ${documentTypeJoinFilter}
            GROUP BY appointment_id
         ) doc ON doc.appointment_id = a.appointment_id
         WHERE ${conditions.join(' AND ')}`,
        countParams
    );

    const total = Number(countRows[0]?.total || 0);
    const totalPages = Math.max(1, Math.ceil(total / filters.pageSize));
    const currentPage = Math.min(filters.page, totalPages);
    const offset = (currentPage - 1) * filters.pageSize;
    const rowsParams = [...documentJoinParams, ...params, filters.pageSize, offset];

    const rows = await query(
        `SELECT
            a.appointment_id,
            a.auid,
            a.appointment_date,
            a.current_token_number AS token_number,
            a.status,
            a.fk_branch_id,
            b.branch_name,
            t.treatment_name,
            s.slot_name,
            c.id AS consultation_id,
            c.doctor_id,
            c.workflow_status,
            c.medication_duration_days,
            c.quick_formula_input,
            COALESCE(NULLIF(c.oxygen_saturation, ''), v.oxygen_saturation) AS oxygen_saturation,
            COALESCE(NULLIF(c.blood_pressure, ''), v.blood_pressure) AS blood_pressure,
            COALESCE(NULLIF(c.patient_height, ''), v.patient_height) AS patient_height,
            COALESCE(NULLIF(c.patient_weight, ''), v.patient_weight) AS patient_weight,
            d.full_name AS doctor_full_name,
            med.medicine_count,
            med.medicine_summary,
            test.test_count,
            bill.bills_count,
            bill.bill_id,
            bill.bill_number,
            bill.bill_type,
            bill.payment_status,
            bill.total_amount,
            bill.paid_amount,
            bill.pending_amount,
            doc.documents_count,
            doc.document_types,
            ${PATIENT_SELECT}
         FROM tbl_appointments a
         JOIN master_users p ON p.id = a.fk_patient_id
         LEFT JOIN tbl_patient_family_members fm ON fm.id = a.fk_patient_family_member_id
         JOIN master_clinic_branches b ON b.id = a.fk_branch_id
         JOIN master_treatments t ON t.id = a.fk_treatment_id
         JOIN master_slots s ON s.id = a.fk_slot_id
         LEFT JOIN tbl_consultations c ON c.appointment_id = a.appointment_id
         LEFT JOIN tbl_appointment_vitals v ON v.appointment_id = a.appointment_id
         LEFT JOIN master_users d ON d.id = c.doctor_id
         LEFT JOIN (
            SELECT consultation_id,
                   COUNT(*) AS medicine_count,
                   GROUP_CONCAT(medicine_value ORDER BY id SEPARATOR ', ') AS medicine_summary
            FROM tbl_consultation_medications
            GROUP BY consultation_id
         ) med ON med.consultation_id = c.id
         LEFT JOIN (
            SELECT consultation_id, COUNT(*) AS test_count
            FROM tbl_consultation_tests
            GROUP BY consultation_id
         ) test ON test.consultation_id = c.id
         LEFT JOIN (
            SELECT appointment_id,
                   COUNT(DISTINCT id) AS bills_count,
                   MAX(id) AS bill_id,
                   MAX(bill_number) AS bill_number,
                   MAX(bill_type) AS bill_type,
                   MAX(payment_status) AS payment_status,
                   SUM(total_amount) AS total_amount,
                   SUM(paid_amount) AS paid_amount,
                   SUM(pending_amount) AS pending_amount
            FROM tbl_bills
            WHERE status = 'ACTIVE'
            GROUP BY appointment_id
         ) bill ON bill.appointment_id = a.appointment_id
         LEFT JOIN (
            SELECT appointment_id,
                   COUNT(DISTINCT id) AS documents_count,
                   GROUP_CONCAT(DISTINCT document_type ORDER BY document_type SEPARATOR ', ') AS document_types
            FROM tbl_patient_clinical_documents
            WHERE status = 'ACTIVE'
              ${documentTypeJoinFilter}
            GROUP BY appointment_id
         ) doc ON doc.appointment_id = a.appointment_id
         WHERE ${conditions.join(' AND ')}
         ORDER BY a.appointment_date DESC, a.current_token_number ASC, a.appointment_id DESC
         LIMIT ? OFFSET ?`,
        rowsParams
    );

    return {
        filters,
        items: rows.map(buildVisitRecord),
        meta: {
            page: currentPage,
            page_size: filters.pageSize,
            total,
            total_pages: totalPages,
        },
    };
};

const fetchConsultationTimeline = async (filters) => {
    const conditions = ['a.is_active = 1'];
    const params = [];
    appendCommonFilters({ conditions, params, filters, aliases: { eventDateExpression: 'c.created_at' } });

    const rows = await query(
        `SELECT
            'CONSULTATION' AS timeline_type,
            c.id AS source_id,
            c.id AS consultation_id,
            c.appointment_id,
            c.doctor_id,
            d.full_name AS doctor_full_name,
            c.workflow_status,
            c.medication_duration_days,
            c.created_at AS event_date,
            c.updated_at,
            a.auid,
            a.appointment_date,
            a.current_token_number AS token_number,
            a.fk_branch_id,
            b.branch_name,
            t.treatment_name,
            ${PATIENT_SELECT}
         FROM tbl_consultations c
         JOIN tbl_appointments a ON a.appointment_id = c.appointment_id
         JOIN master_users p ON p.id = a.fk_patient_id
         LEFT JOIN tbl_patient_family_members fm ON fm.id = a.fk_patient_family_member_id
         JOIN master_clinic_branches b ON b.id = a.fk_branch_id
         JOIN master_treatments t ON t.id = a.fk_treatment_id
         LEFT JOIN master_users d ON d.id = c.doctor_id
         WHERE ${conditions.join(' AND ')}
         ORDER BY c.created_at DESC`,
        params
    );

    return rows.map((row) => ({
        timeline_type: 'CONSULTATION',
        source_id: row.source_id,
        event_date: row.event_date,
        title: 'Consultation',
        status: row.workflow_status || null,
        branch_id: row.fk_branch_id,
        branch_name: row.branch_name,
        doctor_id: row.doctor_id || null,
        doctor_full_name: row.doctor_full_name || null,
        appointment_id: row.appointment_id,
        consultation_id: row.consultation_id,
        bill_id: null,
        document_id: null,
        document_type: null,
        subject: buildSubject(row),
        details: {
            auid: row.auid,
            appointment_date: row.appointment_date,
            token_number: row.token_number,
            treatment_name: row.treatment_name,
            medication_duration_days: row.medication_duration_days,
        },
    }));
};

const fetchPrescriptionTimeline = async (filters) => {
    const conditions = ['a.is_active = 1', 'a.status = \'Completed\''];
    const params = [];
    appendCommonFilters({ conditions, params, filters, aliases: { eventDateExpression: 'a.appointment_date' } });

    const rows = await query(
        `SELECT
            c.id AS source_id,
            c.id AS consultation_id,
            c.appointment_id,
            c.doctor_id,
            d.full_name AS doctor_full_name,
            c.created_at AS consultation_created_at,
            a.appointment_date AS event_date,
            med.medicine_count,
            med.medicine_summary,
            test.test_count,
            a.auid,
            a.appointment_date,
            a.current_token_number AS token_number,
            a.fk_branch_id,
            b.branch_name,
            ${PATIENT_SELECT}
         FROM tbl_consultations c
         JOIN tbl_appointments a ON a.appointment_id = c.appointment_id
         JOIN master_users p ON p.id = a.fk_patient_id
         LEFT JOIN tbl_patient_family_members fm ON fm.id = a.fk_patient_family_member_id
         JOIN master_clinic_branches b ON b.id = a.fk_branch_id
         LEFT JOIN master_users d ON d.id = c.doctor_id
         LEFT JOIN (
            SELECT consultation_id,
                   COUNT(*) AS medicine_count,
                   GROUP_CONCAT(medicine_value ORDER BY id SEPARATOR ', ') AS medicine_summary
            FROM tbl_consultation_medications
            GROUP BY consultation_id
         ) med ON med.consultation_id = c.id
         LEFT JOIN (
            SELECT consultation_id,
                   COUNT(*) AS test_count
            FROM tbl_consultation_tests
            GROUP BY consultation_id
         ) test ON test.consultation_id = c.id
         WHERE ${conditions.join(' AND ')}
           AND (COALESCE(med.medicine_count, 0) > 0 OR COALESCE(test.test_count, 0) > 0)
         ORDER BY a.appointment_date DESC, c.id DESC`,
        params
    );

    return rows.map((row) => ({
        timeline_type: 'PRESCRIPTION',
        source_id: row.source_id,
        event_date: row.event_date,
        title: 'Prescription',
        status: null,
        branch_id: row.fk_branch_id,
        branch_name: row.branch_name,
        doctor_id: row.doctor_id || null,
        doctor_full_name: row.doctor_full_name || null,
        appointment_id: row.appointment_id,
        consultation_id: row.consultation_id,
        bill_id: null,
        document_id: null,
        document_type: 'PRESCRIPTION',
        subject: buildSubject(row),
        details: {
            auid: row.auid,
            appointment_date: row.appointment_date,
            token_number: row.token_number,
            medicine_count: Number(row.medicine_count || 0),
            test_count: Number(row.test_count || 0),
            medicine_summary: row.medicine_summary || null,
            consultation_created_at: row.consultation_created_at,
        },
    }));
};

const fetchBillTimeline = async (filters) => {
    const conditions = ['bills.status = \'ACTIVE\''];
    const params = [];
    appendCommonFilters({
        conditions,
        params,
        filters,
        aliases: {
            appointmentAlias: 'a',
            consultationAlias: 'c',
            patientAlias: 'p',
            familyAlias: 'fm',
            eventDateExpression: 'COALESCE(bills.updated_at, bills.created_at)',
        },
    });

    const rows = await query(
        `SELECT
            bills.id AS source_id,
            bills.id AS bill_id,
            bills.bill_number,
            bills.bill_type,
            bills.payment_status,
            bills.total_amount,
            bills.paid_amount,
            bills.pending_amount,
            bills.created_at AS event_date,
            bills.appointment_id,
            bills.consultation_id,
            c.doctor_id,
            d.full_name AS doctor_full_name,
            a.auid,
            a.appointment_date,
            a.current_token_number AS token_number,
            a.fk_branch_id,
            branch.branch_name,
            ${PATIENT_SELECT}
         FROM tbl_bills bills
         JOIN tbl_appointments a ON a.appointment_id = bills.appointment_id
         JOIN master_users p ON p.id = a.fk_patient_id
         LEFT JOIN tbl_patient_family_members fm ON fm.id = a.fk_patient_family_member_id
         LEFT JOIN tbl_consultations c ON c.id = bills.consultation_id OR c.appointment_id = a.appointment_id
         LEFT JOIN master_users d ON d.id = c.doctor_id
         LEFT JOIN master_clinic_branches branch ON branch.id = a.fk_branch_id
         WHERE ${conditions.join(' AND ')}
         ORDER BY bills.created_at DESC`,
        params
    );

    return rows.map((row) => ({
        timeline_type: 'BILL',
        source_id: row.source_id,
        event_date: row.event_date,
        title: `${row.bill_type || 'Bill'} ${row.bill_number || `#${row.bill_id}`}`,
        status: row.payment_status || null,
        branch_id: row.fk_branch_id,
        branch_name: row.branch_name,
        doctor_id: row.doctor_id || null,
        doctor_full_name: row.doctor_full_name || null,
        appointment_id: row.appointment_id,
        consultation_id: row.consultation_id || null,
        bill_id: row.bill_id,
        document_id: null,
        document_type: 'BILL',
        subject: buildSubject(row),
        details: {
            bill_number: row.bill_number,
            bill_type: row.bill_type,
            total_amount: row.total_amount,
            paid_amount: row.paid_amount,
            pending_amount: row.pending_amount,
            auid: row.auid,
            appointment_date: row.appointment_date,
            token_number: row.token_number,
        },
    }));
};

const appendDocumentFilters = ({ conditions, params, filters }) => {
    conditions.push('doc.fk_branch_id = ?');
    params.push(filters.branchId);

    if (filters.fromDate) {
        conditions.push('DATE(doc.created_at) >= ?');
        params.push(filters.fromDate);
    }

    if (filters.toDate) {
        conditions.push('DATE(doc.created_at) <= ?');
        params.push(filters.toDate);
    }

    if (filters.patientId) {
        conditions.push('doc.patient_id = ?');
        params.push(filters.patientId);
    }

    if (filters.familyMemberId) {
        conditions.push('doc.family_member_id = ?');
        params.push(filters.familyMemberId);
    }

    if (filters.doctorId) {
        conditions.push('doc.doctor_id = ?');
        params.push(filters.doctorId);
    }

    if (filters.documentType) {
        conditions.push('doc.document_type = ?');
        params.push(filters.documentType);
    }

    if (filters.documentStatus) {
        conditions.push('doc.status = ?');
        params.push(filters.documentStatus);
    }

    if (filters.subjectScope === 'SELF') {
        conditions.push('doc.family_member_id IS NULL');
    }

    if (filters.patientSearch) {
        conditions.push(`(
            p.full_name LIKE ?
            OR p.mobile_no LIKE ?
            OR p.uuid LIKE ?
            OR fm.full_name LIKE ?
            OR fm.relationship LIKE ?
            OR doc.title LIKE ?
            OR doc.original_filename LIKE ?
        )`);
        params.push(
            `%${filters.patientSearch}%`,
            `%${filters.patientSearch}%`,
            `%${filters.patientSearch}%`,
            `%${filters.patientSearch}%`,
            `%${filters.patientSearch}%`,
            `%${filters.patientSearch}%`,
            `%${filters.patientSearch}%`
        );
    }
};

const fetchDocumentTimeline = async (filters) => {
    const conditions = [];
    const params = [];
    appendDocumentFilters({ conditions, params, filters });

    const rows = await query(
        `SELECT
            doc.id AS source_id,
            doc.id AS document_id,
            doc.patient_id,
            doc.family_member_id AS fk_patient_family_member_id,
            doc.appointment_id,
            doc.consultation_id,
            doc.bill_id,
            doc.fk_branch_id,
            doc.doctor_id,
            doc.document_type,
            doc.title,
            doc.description,
            doc.original_filename,
            doc.mime_type,
            doc.file_size,
            doc.status,
            doc.created_at AS event_date,
            branch.branch_name,
            d.full_name AS doctor_full_name,
            p.uuid AS patient_uuid,
            p.full_name AS primary_patient_full_name,
            p.mobile_no AS primary_patient_mobile_no,
            p.ward_no AS primary_patient_ward_no,
            p.vidhan_sabha AS primary_patient_vidhan_sabha,
            CASE WHEN doc.family_member_id IS NULL THEN 'SELF' ELSE 'FAMILY_MEMBER' END AS booked_for_type,
            CASE WHEN doc.family_member_id IS NULL THEN 0 ELSE 1 END AS is_family_member_booking,
            fm.relationship AS family_member_relationship,
            fm.full_name AS family_member_full_name,
            fm.age AS family_member_age,
            fm.gender AS family_member_gender,
            COALESCE(fm.full_name, p.full_name) AS patient_full_name,
            COALESCE(fm.age, p.age) AS patient_age,
            COALESCE(fm.gender, p.gender) AS patient_gender
         FROM tbl_patient_clinical_documents doc
         JOIN master_users p ON p.id = doc.patient_id
         LEFT JOIN tbl_patient_family_members fm ON fm.id = doc.family_member_id
         LEFT JOIN master_clinic_branches branch ON branch.id = doc.fk_branch_id
         LEFT JOIN master_users d ON d.id = doc.doctor_id
         WHERE ${conditions.join(' AND ')}
         ORDER BY doc.created_at DESC`,
        params
    );

    return rows.map((row) => ({
        timeline_type: 'DOCUMENT',
        source_id: row.source_id,
        event_date: row.event_date,
        title: row.title || row.original_filename,
        status: row.status,
        branch_id: row.fk_branch_id,
        branch_name: row.branch_name,
        doctor_id: row.doctor_id || null,
        doctor_full_name: row.doctor_full_name || null,
        appointment_id: row.appointment_id || null,
        consultation_id: row.consultation_id || null,
        bill_id: row.bill_id || null,
        document_id: row.document_id,
        document_type: row.document_type,
        subject: buildSubject(row),
        details: {
            description: row.description,
            original_filename: row.original_filename,
            mime_type: row.mime_type,
            file_size: row.file_size,
            ward_no: row.primary_patient_ward_no || null,
            vidhan_sabha: row.primary_patient_vidhan_sabha || null,
        },
    }));
};

const parseTimelineFilters = (rawFilters = {}, actor = {}) => {
    const branchId = toPositiveInt(rawFilters.branch_id || actor.selected_branch_id);
    if (!branchId) {
        throw new AppError('branch_id is required for patient records', 400);
    }

    const fromDate = normalizeDateFilter(rawFilters.from_date, 'from_date');
    const toDate = normalizeDateFilter(rawFilters.to_date, 'to_date');

    if (fromDate && toDate && fromDate > toDate) {
        throw new AppError('from_date must be less than or equal to to_date', 400);
    }

    const page = toPositiveInt(rawFilters.page) || 1;
    const pageSize = Math.min(toPositiveInt(rawFilters.page_size) || toPositiveInt(rawFilters.limit) || 20, 100);

    return {
        branchId,
        patientId: toPositiveInt(rawFilters.patient_id),
        familyMemberId: toPositiveInt(rawFilters.family_member_id),
        doctorId: toPositiveInt(rawFilters.doctor_id),
        patientSearch: normalizeText(rawFilters.patient_search || rawFilters.search, 100),
        fromDate,
        toDate,
        documentType: normalizeDocumentType(rawFilters.document_type),
        documentStatus: normalizeDocumentStatus(rawFilters.document_status),
        timelineType: normalizeTimelineType(rawFilters.timeline_type),
        subjectScope: normalizeSubjectScope(rawFilters.subject_scope),
        page,
        pageSize,
        limit: Math.min(toPositiveInt(rawFilters.limit) || pageSize, 500),
    };
};

const assertPatientHistoryScope = async ({ patientId, familyMemberId = null, subjectScope = 'ALL', branchId }) => {
    const patientRows = await query(
        `SELECT id
         FROM master_users
         WHERE id = ?
           AND role = 'PAT'
           AND is_active = 1
         LIMIT 1`,
        [patientId]
    );

    if (patientRows.length === 0) {
        throw new AppError('Patient not found', 404);
    }

    if (familyMemberId || subjectScope === 'FAMILY_MEMBER') {
        const familyRows = await query(
            `SELECT id
             FROM tbl_patient_family_members
             WHERE id = ?
               AND fk_primary_patient_id = ?
               AND is_active = 1
             LIMIT 1`,
            [familyMemberId, patientId]
        );

        if (familyRows.length === 0) {
            throw new AppError('Family member does not belong to the selected patient', 400);
        }
    }

    const accessRows = await query(
        `SELECT 1
         FROM tbl_appointments
         WHERE fk_patient_id = ?
           AND fk_branch_id = ?
           AND is_active = 1
           AND status = 'Completed'
         LIMIT 1`,
        [patientId, branchId]
    );

    if (accessRows.length === 0) {
        throw new AppError('Patient records not found for selected branch', 404);
    }
};

const listPatientHistory = async ({ patientId, filters: rawFilters, actor }) => {
    const branchId = toPositiveInt(rawFilters.branch_id || actor.selected_branch_id);
    if (!branchId) {
        throw new AppError('branch_id is required for patient records', 400);
    }

    const familyMemberId = toPositiveInt(rawFilters.family_member_id);
    const subjectScope = normalizeSubjectScope(rawFilters.subject_scope);

    await assertPatientHistoryScope({
        patientId,
        familyMemberId,
        subjectScope,
        branchId,
    });

    return listPatientTimeline({
        filters: {
            ...rawFilters,
            branch_id: branchId,
            patient_id: patientId,
            family_member_id: familyMemberId || undefined,
            subject_scope: familyMemberId ? 'FAMILY_MEMBER' : subjectScope,
        },
        actor,
    });
};

const listPatientTimeline = async ({ filters: rawFilters, actor }) => {
    const filters = parseTimelineFilters(rawFilters, actor);
    const timelineType = filters.timelineType;
    const fetchers = [];

    if (!timelineType || timelineType === 'APPOINTMENT') {
        fetchers.push(fetchAppointmentTimeline(filters));
    }

    if (!timelineType || timelineType === 'CONSULTATION') {
        fetchers.push(fetchConsultationTimeline(filters));
    }

    if (!timelineType || timelineType === 'PRESCRIPTION') {
        fetchers.push(fetchPrescriptionTimeline(filters));
    }

    if (!timelineType || timelineType === 'BILL') {
        fetchers.push(fetchBillTimeline(filters));
    }

    if (!timelineType || timelineType === 'DOCUMENT') {
        fetchers.push(fetchDocumentTimeline(filters));
    }

    const rows = (await Promise.all(fetchers)).flat();
    rows.sort((a, b) => new Date(b.event_date).getTime() - new Date(a.event_date).getTime());
    const total = rows.length;
    const totalPages = Math.max(1, Math.ceil(total / filters.pageSize));
    const currentPage = Math.min(filters.page, totalPages);
    const offset = (currentPage - 1) * filters.pageSize;

    return {
        filters,
        items: rows.slice(offset, offset + filters.pageSize),
        meta: {
            page: currentPage,
            page_size: filters.pageSize,
            total,
            total_pages: totalPages,
        },
    };
};

const resolveDocumentSubject = async ({ connection, payload, branchId }) => {
    const appointmentId = toPositiveInt(payload.appointment_id);
    if (appointmentId) {
        const [rows] = await connection.execute(
            `SELECT a.appointment_id,
                    a.fk_patient_id AS patient_id,
                    a.fk_patient_family_member_id AS family_member_id,
                    a.fk_branch_id,
                    c.id AS consultation_id,
                    c.doctor_id
             FROM tbl_appointments a
             LEFT JOIN tbl_consultations c ON c.appointment_id = a.appointment_id
             WHERE a.appointment_id = ?
             LIMIT 1`,
            [appointmentId]
        );

        const appointment = rows[0];
        if (!appointment) {
            throw new AppError('Linked appointment not found', 404);
        }

        if (Number(appointment.fk_branch_id) !== Number(branchId)) {
            throw new AppError('Linked appointment belongs to a different branch', 403);
        }

        return {
            patientId: Number(appointment.patient_id),
            familyMemberId: appointment.family_member_id ? Number(appointment.family_member_id) : null,
            appointmentId,
            consultationId: toPositiveInt(payload.consultation_id) || appointment.consultation_id || null,
            billId: toPositiveInt(payload.bill_id),
            doctorId: toPositiveInt(payload.doctor_id) || appointment.doctor_id || null,
        };
    }

    const patientId = toPositiveInt(payload.patient_id);
    if (!patientId) {
        throw new AppError('patient_id or appointment_id is required', 400);
    }

    const [patientRows] = await connection.execute(
        `SELECT id
         FROM master_users
         WHERE id = ?
           AND role = 'PAT'
           AND is_active = 1
         LIMIT 1`,
        [patientId]
    );

    if (patientRows.length === 0) {
        throw new AppError('Patient not found', 404);
    }

    const familyMemberId = toPositiveInt(payload.family_member_id);
    if (familyMemberId) {
        const [familyRows] = await connection.execute(
            `SELECT id
             FROM tbl_patient_family_members
             WHERE id = ?
               AND fk_primary_patient_id = ?
               AND is_active = 1
             LIMIT 1`,
            [familyMemberId, patientId]
        );

        if (familyRows.length === 0) {
            throw new AppError('Family member does not belong to the selected patient', 400);
        }
    }

    return {
        patientId,
        familyMemberId,
        appointmentId: null,
        consultationId: toPositiveInt(payload.consultation_id),
        billId: toPositiveInt(payload.bill_id),
        doctorId: toPositiveInt(payload.doctor_id),
    };
};

const assertLinkedEntitiesBelongToSubject = async ({ connection, subject, branchId }) => {
    if (subject.consultationId) {
        const [rows] = await connection.execute(
            `SELECT c.id,
                    c.doctor_id,
                    a.fk_patient_id,
                    a.fk_patient_family_member_id,
                    a.fk_branch_id
             FROM tbl_consultations c
             JOIN tbl_appointments a ON a.appointment_id = c.appointment_id
             WHERE c.id = ?
             LIMIT 1`,
            [subject.consultationId]
        );

        const row = rows[0];
        if (!row) {
            throw new AppError('Linked consultation not found', 404);
        }

        if (
            Number(row.fk_branch_id) !== Number(branchId)
            || Number(row.fk_patient_id) !== Number(subject.patientId)
            || Number(row.fk_patient_family_member_id || 0) !== Number(subject.familyMemberId || 0)
        ) {
            throw new AppError('Linked consultation does not match the selected patient record', 400);
        }

        subject.doctorId = subject.doctorId || row.doctor_id || null;
    }

    if (subject.billId) {
        const [rows] = await connection.execute(
            `SELECT b.id,
                    b.patient_id,
                    b.fk_branch_id,
                    a.fk_patient_family_member_id
             FROM tbl_bills b
             LEFT JOIN tbl_appointments a ON a.appointment_id = b.appointment_id
             WHERE b.id = ?
             LIMIT 1`,
            [subject.billId]
        );

        const row = rows[0];
        if (!row) {
            throw new AppError('Linked bill not found', 404);
        }

        if (
            Number(row.fk_branch_id) !== Number(branchId)
            || Number(row.patient_id) !== Number(subject.patientId)
            || Number(row.fk_patient_family_member_id || 0) !== Number(subject.familyMemberId || 0)
        ) {
            throw new AppError('Linked bill does not match the selected patient record', 400);
        }
    }
};

const saveDocumentFile = async ({ file, ext }) => {
    const now = new Date();
    const relativeDirectory = [
        String(now.getFullYear()),
        String(now.getMonth() + 1).padStart(2, '0'),
    ].join(path.sep);
    const storageRoot = getClinicalDocumentStorageRoot();
    const targetDirectory = path.join(storageRoot, relativeDirectory);
    const filename = buildSafeFilename(file.originalname, ext, 'clinical-document');
    const storageKey = path.join(relativeDirectory, filename);
    const absolutePath = path.join(storageRoot, storageKey);

    await fsp.mkdir(targetDirectory, { recursive: true, mode: 0o700 });
    await fsp.writeFile(absolutePath, file.buffer, { mode: 0o600 });

    return {
        storageDriver: 'local_private',
        storageKey,
        absolutePath,
        checksumSha256: crypto.createHash('sha256').update(file.buffer).digest('hex'),
    };
};

const logDocumentAccess = async (connection, payload) => {
    await connection.execute(
        `INSERT INTO log_patient_clinical_document_access
            (document_id, patient_id, family_member_id, fk_branch_id, action,
             actor_user_id, actor_role, ip_address, user_agent, metadata_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            payload.documentId,
            payload.patientId,
            payload.familyMemberId || null,
            payload.branchId,
            payload.action,
            payload.actorUserId || null,
            payload.actorRole || null,
            payload.ipAddress || null,
            payload.userAgent || null,
            payload.metadata ? JSON.stringify(payload.metadata) : null,
        ]
    );
};

const createClinicalDocument = async ({ file, payload, actor, requestMeta }) => {
    const branchId = toPositiveInt(payload.branch_id || actor.selected_branch_id);
    if (!branchId) {
        throw new AppError('branch_id is required for clinical documents', 400);
    }

    const documentType = normalizeDocumentType(payload.document_type, { required: true });
    const title = normalizeText(payload.title, 150) || normalizeText(file?.originalname, 150);
    if (!title) {
        throw new AppError('title is required', 400);
    }

    const fileDetails = await validateClinicalDocumentUpload(file, env.storage.clinicalDocumentMaxBytes);
    const storedFile = await saveDocumentFile({ file, ext: fileDetails.ext });

    try {
        return await withTransaction(async (connection) => {
            const subject = await resolveDocumentSubject({ connection, payload, branchId });
            await assertLinkedEntitiesBelongToSubject({ connection, subject, branchId });

            const [insertResult] = await connection.execute(
                `INSERT INTO tbl_patient_clinical_documents
                    (patient_id, family_member_id, appointment_id, consultation_id, bill_id,
                     fk_branch_id, doctor_id, document_type, title, description,
                     original_filename, storage_driver, storage_key, mime_type, file_size,
                     checksum_sha256, status, created_by, updated_by, created_ip)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?, ?)`,
                [
                    subject.patientId,
                    subject.familyMemberId,
                    subject.appointmentId,
                    subject.consultationId,
                    subject.billId,
                    branchId,
                    subject.doctorId,
                    documentType,
                    title,
                    normalizeText(payload.description, 500),
                    file.originalname,
                    storedFile.storageDriver,
                    storedFile.storageKey,
                    fileDetails.mime,
                    file.size,
                    storedFile.checksumSha256,
                    actor.id,
                    actor.id,
                    requestMeta.ipAddress,
                ]
            );

            const documentId = Number(insertResult.insertId);
            await logDocumentAccess(connection, {
                documentId,
                patientId: subject.patientId,
                familyMemberId: subject.familyMemberId,
                branchId,
                action: 'CREATE',
                actorUserId: actor.id,
                actorRole: actor.role_code || actor.role,
                ipAddress: requestMeta.ipAddress,
                userAgent: requestMeta.userAgent,
                metadata: { document_type: documentType },
            });

            return { document_id: documentId };
        });
    } catch (error) {
        await fsp.unlink(storedFile.absolutePath).catch(() => {});
        throw error;
    }
};

const getDocumentForActor = async ({ documentId, branchId, allowedStatuses = ['ACTIVE'] }) => {
    const params = [documentId, branchId, allowedStatuses];
    const rows = await query(
        `SELECT doc.*,
                p.full_name AS primary_patient_full_name,
                p.uuid AS patient_uuid,
                fm.full_name AS family_member_full_name,
                fm.relationship AS family_member_relationship
         FROM tbl_patient_clinical_documents doc
         JOIN master_users p ON p.id = doc.patient_id
         LEFT JOIN tbl_patient_family_members fm ON fm.id = doc.family_member_id
         WHERE doc.id = ?
           AND doc.fk_branch_id = ?
           AND doc.status IN (?)
         LIMIT 1`,
        params
    );

    if (rows.length === 0) {
        throw new AppError('Clinical document not found', 404);
    }

    return rows[0];
};

const getClinicalDocumentDownload = async ({ documentId, actor, requestMeta }) => {
    const branchId = toPositiveInt(actor.selected_branch_id);
    if (!branchId) {
        throw new AppError('branch_id is required for clinical documents', 400);
    }

    const document = await getDocumentForActor({ documentId, branchId, allowedStatuses: ['ACTIVE'] });
    const absolutePath = path.join(getClinicalDocumentStorageRoot(), document.storage_key);

    if (!fs.existsSync(absolutePath)) {
        throw new AppError('Clinical document file is not available on storage', 404);
    }

    await withTransaction(async (connection) => {
        await logDocumentAccess(connection, {
            documentId: document.id,
            patientId: document.patient_id,
            familyMemberId: document.family_member_id,
            branchId: document.fk_branch_id,
            action: 'DOWNLOAD',
            actorUserId: actor.id,
            actorRole: actor.role_code || actor.role,
            ipAddress: requestMeta.ipAddress,
            userAgent: requestMeta.userAgent,
        });
    });

    return {
        document,
        absolutePath,
    };
};

const updateDocumentStatus = async ({ documentId, status, reason, actor, requestMeta }) => {
    const branchId = toPositiveInt(actor.selected_branch_id);
    if (!branchId) {
        throw new AppError('branch_id is required for clinical documents', 400);
    }

    return withTransaction(async (connection) => {
        const [rows] = await connection.execute(
            `SELECT *
             FROM tbl_patient_clinical_documents
             WHERE id = ?
               AND fk_branch_id = ?
               AND status = 'ACTIVE'
             LIMIT 1
             FOR UPDATE`,
            [documentId, branchId]
        );

        const document = rows[0];
        if (!document) {
            throw new AppError('Active clinical document not found', 404);
        }

        const nowColumn = status === 'ARCHIVED' ? 'archived_at' : 'deleted_at';
        const byColumn = status === 'ARCHIVED' ? 'archived_by' : 'deleted_by';
        const reasonColumn = status === 'ARCHIVED' ? 'archive_reason' : 'delete_reason';

        await connection.execute(
            `UPDATE tbl_patient_clinical_documents
             SET status = ?,
                 ${nowColumn} = CURRENT_TIMESTAMP,
                 ${byColumn} = ?,
                 ${reasonColumn} = ?,
                 updated_by = ?
             WHERE id = ?`,
            [
                status,
                actor.id,
                normalizeText(reason, 255),
                actor.id,
                documentId,
            ]
        );

        await logDocumentAccess(connection, {
            documentId: document.id,
            patientId: document.patient_id,
            familyMemberId: document.family_member_id,
            branchId: document.fk_branch_id,
            action: status,
            actorUserId: actor.id,
            actorRole: actor.role_code || actor.role,
            ipAddress: requestMeta.ipAddress,
            userAgent: requestMeta.userAgent,
            metadata: { reason: normalizeText(reason, 255) },
        });

        return { document_id: documentId, status };
    });
};

const buildRequestMeta = (req) => ({
    ipAddress: getClientIp(req),
    userAgent: req.headers?.['user-agent'] || null,
});

module.exports = {
    DOCUMENT_TYPES,
    DOCUMENT_STATUSES,
    parseRegistryFilters,
    parseTimelineFilters,
    listPatientRegistry,
    getPatientRecordDetail,
    listPatientVisits,
    listPatientHistory,
    listPatientTimeline,
    createClinicalDocument,
    getClinicalDocumentDownload,
    updateDocumentStatus,
    buildRequestMeta,
    toPositiveInt,
    safeJsonParse,
    buildSubject,
    buildVisitRecord,
};
