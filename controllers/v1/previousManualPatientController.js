const bcrypt = require('bcryptjs');
const { randomUUID } = require('crypto');
const { query, withTransaction } = require('../../config/db');
const AppError = require('../../utils/AppError');
const asyncHandler = require('../../utils/asyncHandler');

const PATIENT_ROLE = 'PAT';

const formatPatientRegistrationDate = (date = new Date()) => {
    const day = String(date.getDate()).padStart(2, '0');
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const year = String(date.getFullYear());
    return `${day}${month}${year}`;
};

const toPositiveInt = (value) => {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) {
        return null;
    }
    return parsed;
};

const validateGender = (gender) => ['male', 'female', 'other'].includes(String(gender || '').toLowerCase());
const validateMobile = (mobileNo) => /^[6-9]\d{9}$/.test(String(mobileNo || '').trim());
const validateEmail = (email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || '').trim());

const generateTodayPatientUuid = async (connection, date = new Date()) => {
    const datePart = formatPatientRegistrationDate(date);
    const prefix = `PAT${datePart}`;
    const lockName = `patient_uuid_${datePart}`;

    const [lockRows] = await connection.execute('SELECT GET_LOCK(?, 10) AS acquired_lock', [lockName]);

    if (!lockRows[0]?.acquired_lock) {
        throw new AppError('Unable to generate patient ID right now. Please try again.', 503);
    }

    try {
        const [existingRows] = await connection.execute(
            `SELECT uuid
             FROM master_users
             WHERE uuid LIKE ?
             ORDER BY uuid DESC
             LIMIT 1`,
            [`${prefix}%`]
        );

        const lastUuid = existingRows[0]?.uuid || null;
        const lastSerial = lastUuid ? Number(String(lastUuid).slice(prefix.length)) : 0;
        const nextSerial = lastSerial + 1;

        if (nextSerial > 9999) {
            throw new AppError('Daily patient registration limit exceeded for PAT ID generation', 409);
        }

        return `${prefix}${String(nextSerial).padStart(4, '0')}`;
    } finally {
        await connection.execute('DO RELEASE_LOCK(?)', [lockName]);
    }
};

const getClientIp = (req) => {
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) {
        return forwarded.split(',')[0].trim();
    }
    return req.ip || req.socket?.remoteAddress || '0.0.0.0';
};

const normalizeCreatePayload = (body = {}) => {
    const fullName = String(body.full_name || '').trim();
    const patientIdRaw =
        body.patient_id !== undefined && body.patient_id !== null ? String(body.patient_id).trim() : '';
    const age = toPositiveInt(body.age);
    const gender = String(body.gender || '').trim().toLowerCase();
    const mobileNo = String(body.mobile_no || '').trim();
    const emailRaw = body.email !== undefined && body.email !== null ? String(body.email).trim() : '';
    const addressRaw = body.address !== undefined && body.address !== null ? String(body.address).trim() : '';
    const wardNoRaw = body.ward_no !== undefined && body.ward_no !== null ? String(body.ward_no).trim() : '';
    const vidhanSabhaRaw = body.vidhan_sabha !== undefined && body.vidhan_sabha !== null ? String(body.vidhan_sabha).trim() : '';
    const pincodeRaw = body.pincode !== undefined && body.pincode !== null ? String(body.pincode).trim() : '';
    const cityRaw = body.city !== undefined && body.city !== null ? String(body.city).trim() : '';
    const descriptionRaw =
        body.description !== undefined && body.description !== null ? String(body.description).trim() : '';

    if (!fullName || fullName.length > 100) {
        throw new AppError('full_name must be between 1 and 100 characters', 400);
    }

    if (patientIdRaw && patientIdRaw.length > 50) {
        throw new AppError('patient_id must be at most 50 characters', 400);
    }

    if (!age || age < 1 || age > 120) {
        throw new AppError('age must be between 1 and 120', 400);
    }

    if (!validateGender(gender)) {
        throw new AppError("gender must be one of 'male', 'female' or 'other'", 400);
    }

    if (!validateMobile(mobileNo)) {
        throw new AppError('mobile_no must be a valid 10-digit number starting with 6, 7, 8 or 9', 400);
    }

    if (emailRaw && !validateEmail(emailRaw)) {
        throw new AppError('email must be a valid email address', 400);
    }

    if (pincodeRaw && !/^\d{6}$/.test(pincodeRaw)) {
        throw new AppError('pincode must be a valid 6-digit number', 400);
    }

    const combinedAddress = [
        addressRaw || null,
        wardNoRaw ? `Ward ${wardNoRaw}` : null,
        vidhanSabhaRaw || null,
        pincodeRaw || null,
        cityRaw || null,
    ].filter(Boolean).join(', ');

    return {
        full_name: fullName,
        patient_id: patientIdRaw || null,
        age,
        gender,
        mobile_no: mobileNo,
        email: emailRaw || null,
        address: combinedAddress || null,
        area_name: addressRaw || null,
        ward_no: wardNoRaw || null,
        vidhan_sabha: vidhanSabhaRaw || null,
        pincode: pincodeRaw || null,
        city: cityRaw || null,
        description: descriptionRaw || null,
    };
};

const createPreviousManualPatient = asyncHandler(async (req, res) => {
    const payload = normalizeCreatePayload(req.body);
    const actorIp = getClientIp(req);
    const actorRole = req.user?.role_code || req.user?.role || null;

    if (!req.user?.id) {
        throw new AppError('Authenticated user is required', 401);
    }

    if (!actorRole) {
        throw new AppError('Unable to determine actor role for audit log', 400);
    }

    if (!payload.patient_id) {
        throw new AppError('patient_id is required for previous patient registration', 400);
    }

    const saved = await withTransaction(async (connection) => {
        const [matchedRows] = await connection.execute(
            `SELECT id, role
             FROM master_users
             WHERE mobile_no = ?
             LIMIT 1
             FOR UPDATE`,
            [payload.mobile_no]
        );

        let patientId;
        let action;

        if (matchedRows.length > 0) {
            const matched = matchedRows[0];
            if (String(matched.role || '').toUpperCase() !== PATIENT_ROLE) {
                throw new AppError('Mobile number already belongs to a non-patient user', 409);
            }

            await connection.execute(
                `UPDATE master_users
                 SET clinic_patient_no = ?,
                     area_name = ?,
                     ward_no = ?,
                     vidhan_sabha = ?,
                     pincode = ?,
                     city = ?,
                     address = ?,
                     updated_by = ?,
                     updated_ip = ?
                 WHERE id = ?`,
                [
                    payload.patient_id,
                    payload.area_name,
                    payload.ward_no,
                    payload.vidhan_sabha,
                    payload.pincode,
                    payload.city,
                    payload.address,
                    req.user.id,
                    actorIp,
                    matched.id,
                ]
            );

            patientId = matched.id;
            action = 'LINK_EXISTING';
        } else {
            const generatedPatientUuid = await generateTodayPatientUuid(connection);
            const generatedPasswordHash = await bcrypt.hash(randomUUID(), 10);

            const [insertResult] = await connection.execute(
                `INSERT INTO master_users
                 (uuid, clinic_patient_no, full_name, age, gender, email, address, area_name, ward_no,
                  vidhan_sabha, pincode, city, description, mobile_no, password,
                  role, is_active, created_by, updated_by, created_ip, updated_ip)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
                [
                    generatedPatientUuid,
                    payload.patient_id,
                    payload.full_name,
                    payload.age,
                    payload.gender,
                    payload.email,
                    payload.address,
                    payload.area_name,
                    payload.ward_no,
                    payload.vidhan_sabha,
                    payload.pincode,
                    payload.city,
                    payload.description,
                    payload.mobile_no,
                    generatedPasswordHash,
                    PATIENT_ROLE,
                    req.user.id,
                    req.user.id,
                    actorIp,
                    actorIp,
                ]
            );

            patientId = insertResult.insertId;
            action = 'CREATE_PATIENT';
        }

        const [rows] = await connection.execute(
            `SELECT
                u.id AS previous_patient_id,
                u.id AS linked_patient_id,
                u.full_name,
                u.clinic_patient_no AS patient_id,
                u.age,
                u.gender,
                u.mobile_no,
                u.email,
                u.address,
                u.area_name,
                u.ward_no,
                u.vidhan_sabha,
                u.pincode,
                u.city,
                u.description,
                NULL AS fk_branch_id,
                COALESCE(u.updated_by, u.created_by) AS entered_by_user_id,
                ? AS entered_by_role,
                actor.full_name AS entered_by_name,
                u.is_active,
                u.updated_at AS created_at,
                u.updated_at,
                ? AS import_action
             FROM master_users u
             LEFT JOIN master_users actor ON actor.id = COALESCE(u.updated_by, u.created_by)
             WHERE u.id = ?
             LIMIT 1`,
            [actorRole, action, patientId]
        );

        return rows[0];
    });

    return res.status(201).json({
        success: true,
        message: saved.import_action === 'LINK_EXISTING'
            ? 'Previous patient ID linked to existing patient successfully'
            : 'Previous patient registered successfully',
        data: saved,
    });
});

const listPreviousManualPatients = asyncHandler(async (req, res) => {
    const search = req.query.search ? String(req.query.search).trim() : null;
    const page = toPositiveInt(req.query.page) || 1;
    const requestedPageSize = toPositiveInt(req.query.page_size) || 20;
    const pageSize = Math.min(requestedPageSize, 100);
    const offset = (page - 1) * pageSize;

    const conditions = ["u.role = 'PAT'", 'u.is_active = 1', 'u.clinic_patient_no IS NOT NULL'];
    const params = [];

    if (search) {
        conditions.push(
            '(u.full_name LIKE ? OR u.clinic_patient_no LIKE ? OR u.mobile_no LIKE ? OR u.email LIKE ? OR u.uuid LIKE ?)'
        );
        params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
    }

    const whereClause = `WHERE ${conditions.join(' AND ')}`;

    const [countRows, rows] = await Promise.all([
        query(
            `SELECT COUNT(*) AS total
             FROM master_users u
             ${whereClause}`,
            params
        ),
        query(
            `SELECT
                u.id AS previous_patient_id,
                u.id AS linked_patient_id,
                u.full_name,
                u.clinic_patient_no AS patient_id,
                u.age,
                u.gender,
                u.mobile_no,
                u.email,
                u.address,
                u.area_name,
                u.ward_no,
                u.vidhan_sabha,
                u.pincode,
                u.city,
                u.description,
                NULL AS fk_branch_id,
                COALESCE(u.updated_by, u.created_by) AS entered_by_user_id,
                actor.role AS entered_by_role,
                actor.full_name AS entered_by_name,
                u.is_active,
                u.updated_at AS created_at,
                u.updated_at
             FROM master_users u
             LEFT JOIN master_users actor ON actor.id = COALESCE(u.updated_by, u.created_by)
             ${whereClause}
             ORDER BY u.updated_at DESC, u.id DESC
             LIMIT ${pageSize} OFFSET ${offset}`,
            params
        ),
    ]);

    const total = Number(countRows[0]?.total || 0);

    return res.status(200).json({
        success: true,
        message: 'Previous patients fetched successfully',
        data: rows,
        meta: {
            search,
            page,
            page_size: pageSize,
            total,
            total_pages: Math.max(1, Math.ceil(total / pageSize)),
        },
    });
});

const getPreviousManualPatientEntryLogs = asyncHandler(async (req, res) => {
    const previousPatientId = toPositiveInt(req.params.previous_patient_id);
    if (!previousPatientId) {
        throw new AppError('Valid previous_patient_id is required', 400);
    }

    const patients = await query(
        `SELECT id
         FROM master_users
         WHERE id = ?
           AND role = 'PAT'
           AND clinic_patient_no IS NOT NULL
         LIMIT 1`,
        [previousPatientId]
    );

    if (patients.length === 0) {
        throw new AppError('Previous patient not found', 404);
    }

    return res.status(200).json({
        success: true,
        message: 'Previous patient entry logs are not enabled for this flow',
        data: [],
        meta: {
            previous_patient_id: previousPatientId,
            total: 0,
        },
    });
});

module.exports = {
    createPreviousManualPatient,
    listPreviousManualPatients,
    getPreviousManualPatientEntryLogs,
};
