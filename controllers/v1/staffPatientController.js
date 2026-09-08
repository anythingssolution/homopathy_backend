const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { randomUUID } = require('crypto');
const { query, withTransaction } = require('../../config/db');
const { env } = require('../../config/env');
const AppError = require('../../utils/AppError');
const asyncHandler = require('../../utils/asyncHandler');

const PATIENT_ROLE = 'PAT';
const CREATOR_ROLE_FILTERS = new Set(['SELF', 'DOC', 'REC', 'MED']);

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

const verifyStaffRegistrationToken = (token, mobileNo) => {
    let payload;
    try {
        payload = jwt.verify(token, env.registrationTokenSecret);
    } catch (error) {
        throw new AppError('Invalid or expired OTP verification. Please verify the mobile number again.', 401);
    }

    if (payload.purpose !== 'register_verified') {
        throw new AppError('Invalid OTP verification token', 401);
    }

    if (String(payload.mobile_no || '').trim() !== String(mobileNo).trim()) {
        throw new AppError('Verified mobile number does not match the submitted number', 400);
    }
};
const isValidDateString = (value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));

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

const creatorRoleSelect = `
    CASE
        WHEN u.created_by IS NULL THEN 'SELF'
        WHEN creator.role = 'DOC' THEN 'DOC'
        WHEN creator.role = 'REC' THEN 'REC'
        WHEN creator.role IN ('MED', 'MEDS') THEN 'MED'
        ELSE COALESCE(creator.role, 'STAFF')
    END
`;

const mapPatientRow = (row) => ({
    patient_id: Number(row.patient_id),
    patient_uuid: row.patient_uuid,
    full_name: row.full_name,
    age: Number(row.age),
    gender: row.gender,
    mobile_no: row.mobile_no,
    created_at: row.created_at,
    created_by_user_id: row.created_by_user_id ? Number(row.created_by_user_id) : null,
    created_by_name: row.created_by_name || null,
    created_by_role: row.created_by_role || 'SELF',
});

const createStaffPatient = asyncHandler(async (req, res) => {
    const fullName = String(req.body?.full_name || '').trim();
    const mobileNo = String(req.body?.mobile_no || '').trim();
    const gender = String(req.body?.gender || '').trim().toLowerCase();
    const parsedAge = Number(req.body?.age);
    const registrationToken = String(req.body?.registration_token || '').trim();

    if (!fullName || !mobileNo || req.body?.age === undefined || !gender || !registrationToken) {
        throw new AppError('full_name, mobile_no, age, gender and verified OTP token are required', 400);
    }

    if (!validateMobile(mobileNo)) {
        throw new AppError('mobile_no must be a valid 10-digit number starting with 6, 7, 8 or 9', 400);
    }

    verifyStaffRegistrationToken(registrationToken, mobileNo);

    if (!Number.isInteger(parsedAge) || parsedAge < 1 || parsedAge > 120) {
        throw new AppError('age must be a valid number between 1 and 120', 400);
    }

    if (!validateGender(gender)) {
        throw new AppError("gender must be one of: 'male', 'female', 'other'", 400);
    }

    const createdIp = getClientIp(req);

    const insertId = await withTransaction(async (connection) => {
        const [existingRows] = await connection.execute(
            `SELECT id
             FROM master_users
             WHERE mobile_no = ?
             LIMIT 1
             FOR UPDATE`,
            [mobileNo]
        );

        if (existingRows.length > 0) {
            throw new AppError('Mobile number already registered', 409);
        }

        const generatedPatientUuid = await generateTodayPatientUuid(connection);
        const generatedPasswordHash = await bcrypt.hash(randomUUID(), 10);

        const [insertResult] = await connection.execute(
            `INSERT INTO master_users
             (uuid, full_name, age, gender, email, description, mobile_no, password, role, is_active, created_by, updated_by, created_ip, updated_ip)
             VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, ?, 1, ?, ?, ?, ?)`,
            [
                generatedPatientUuid,
                fullName,
                parsedAge,
                gender,
                mobileNo,
                generatedPasswordHash,
                PATIENT_ROLE,
                req.user.id,
                req.user.id,
                createdIp,
                createdIp,
            ]
        );

        return insertResult.insertId;
    });

    const rows = await query(
        `SELECT
            u.id AS patient_id,
            u.uuid AS patient_uuid,
            u.full_name,
            u.age,
            u.gender,
            u.mobile_no,
            u.created_at,
            u.created_by AS created_by_user_id,
            creator.full_name AS created_by_name,
            ${creatorRoleSelect} AS created_by_role
         FROM master_users u
         LEFT JOIN master_users creator ON creator.id = u.created_by
         WHERE u.id = ?
         LIMIT 1`,
        [insertId]
    );

    return res.status(201).json({
        success: true,
        message: 'Patient created successfully',
        data: mapPatientRow(rows[0]),
    });
});

const listStaffPatients = asyncHandler(async (req, res) => {
    const search = req.query.search ? String(req.query.search).trim() : null;
    const createdFrom = req.query.created_from ? String(req.query.created_from).trim() : null;
    const createdTo = req.query.created_to ? String(req.query.created_to).trim() : null;
    const createdByRole = req.query.created_by_role
        ? String(req.query.created_by_role).trim().toUpperCase()
        : null;
    const page = toPositiveInt(req.query.page) || 1;
    const requestedPageSize = toPositiveInt(req.query.page_size) || 20;
    const pageSize = Math.min(requestedPageSize, 100);
    const offset = (page - 1) * pageSize;

    if (createdFrom && !isValidDateString(createdFrom)) {
        throw new AppError('created_from must be in YYYY-MM-DD format', 400);
    }

    if (createdTo && !isValidDateString(createdTo)) {
        throw new AppError('created_to must be in YYYY-MM-DD format', 400);
    }

    if (createdFrom && createdTo && createdFrom > createdTo) {
        throw new AppError('created_from cannot be after created_to', 400);
    }

    if (createdByRole && createdByRole !== 'ALL' && !CREATOR_ROLE_FILTERS.has(createdByRole)) {
        throw new AppError("created_by_role must be one of 'ALL', 'SELF', 'DOC', 'REC', 'MED'", 400);
    }

    const conditions = [`u.role = '${PATIENT_ROLE}'`, 'u.is_active = 1'];
    const params = [];

    if (search) {
        conditions.push('(u.full_name LIKE ? OR u.mobile_no LIKE ? OR u.uuid LIKE ?)');
        params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }

    if (createdFrom) {
        conditions.push('DATE(u.created_at) >= ?');
        params.push(createdFrom);
    }

    if (createdTo) {
        conditions.push('DATE(u.created_at) <= ?');
        params.push(createdTo);
    }

    if (createdByRole === 'SELF') {
        conditions.push('u.created_by IS NULL');
    } else if (createdByRole === 'DOC') {
        conditions.push("creator.role = 'DOC'");
    } else if (createdByRole === 'REC') {
        conditions.push("creator.role = 'REC'");
    } else if (createdByRole === 'MED') {
        conditions.push("creator.role IN ('MED', 'MEDS')");
    }

    const whereClause = `WHERE ${conditions.join(' AND ')}`;

    const [countRows, rows] = await Promise.all([
        query(
            `SELECT COUNT(*) AS total
             FROM master_users u
             LEFT JOIN master_users creator ON creator.id = u.created_by
             ${whereClause}`,
            params
        ),
        query(
            `SELECT
                u.id AS patient_id,
                u.uuid AS patient_uuid,
                u.full_name,
                u.age,
                u.gender,
                u.mobile_no,
                u.created_at,
                u.created_by AS created_by_user_id,
                creator.full_name AS created_by_name,
                ${creatorRoleSelect} AS created_by_role
             FROM master_users u
             LEFT JOIN master_users creator ON creator.id = u.created_by
             ${whereClause}
             ORDER BY u.created_at DESC, u.id DESC
             LIMIT ${pageSize} OFFSET ${offset}`,
            params
        ),
    ]);

    const total = Number(countRows[0]?.total || 0);
    const totalPages = Math.max(1, Math.ceil(total / pageSize));

    return res.status(200).json({
        success: true,
        message: 'Staff patients fetched successfully',
        data: rows.map(mapPatientRow),
        meta: {
            search,
            created_from: createdFrom,
            created_to: createdTo,
            created_by_role: createdByRole || 'ALL',
            page,
            page_size: pageSize,
            total,
            total_pages: totalPages,
        },
    });
});

module.exports = {
    createStaffPatient,
    listStaffPatients,
};
