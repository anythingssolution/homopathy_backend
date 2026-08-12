const { query, withTransaction } = require('../../config/db');
const AppError = require('../../utils/AppError');
const asyncHandler = require('../../utils/asyncHandler');

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

    return {
        full_name: fullName,
        patient_id: patientIdRaw || null,
        age,
        gender,
        mobile_no: mobileNo,
        email: emailRaw || null,
        address: addressRaw || null,
        description: descriptionRaw || null,
    };
};

const assertMobileAvailable = async (connection, mobileNo) => {
    const [masterRows] = await connection.execute(
        `SELECT id
         FROM master_users
         WHERE mobile_no = ?
         LIMIT 1`,
        [mobileNo]
    );

    if (masterRows.length > 0) {
        throw new AppError('Mobile number already registered in the system for an existing user', 409);
    }

    const [previousRows] = await connection.execute(
        `SELECT id
         FROM tbl_previous_manual_patients
         WHERE mobile_no = ?
         LIMIT 1`,
        [mobileNo]
    );

    if (previousRows.length > 0) {
        throw new AppError('Mobile number already exists in previous manual patient records', 409);
    }
};

const assertPatientIdAvailable = async (connection, patientId) => {
    if (!patientId) return;

    const [previousRows] = await connection.execute(
        `SELECT id
         FROM tbl_previous_manual_patients
         WHERE patient_id = ?
         LIMIT 1`,
        [patientId]
    );

    if (previousRows.length > 0) {
        throw new AppError('Patient ID already exists in previous manual patient records', 409);
    }
};

const createPreviousManualPatient = asyncHandler(async (req, res) => {
    const payload = normalizeCreatePayload(req.body);
    const actorIp = getClientIp(req);
    const actorRole = req.user?.role_code || req.user?.role || null;
    const actorUserAgent = req.headers['user-agent'] || null;
    const branchId = req.selectedBranchId || null;

    if (!req.user?.id) {
        throw new AppError('Authenticated user is required', 401);
    }

    if (!actorRole) {
        throw new AppError('Unable to determine actor role for audit log', 400);
    }

    const created = await withTransaction(async (connection) => {
        await assertMobileAvailable(connection, payload.mobile_no);
        await assertPatientIdAvailable(connection, payload.patient_id);

        const [insertResult] = await connection.execute(
            `INSERT INTO tbl_previous_manual_patients
             (full_name, patient_id, age, gender, mobile_no, email, address, description, fk_branch_id,
              entered_by_user_id, entered_by_role, is_active, created_by, updated_by, created_ip, updated_ip)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
            [
                payload.full_name,
                payload.patient_id,
                payload.age,
                payload.gender,
                payload.mobile_no,
                payload.email,
                payload.address,
                payload.description,
                branchId,
                req.user.id,
                actorRole,
                req.user.id,
                req.user.id,
                actorIp,
                actorIp,
            ]
        );

        const previousPatientId = insertResult.insertId;

        await connection.execute(
            `INSERT INTO log_previous_manual_patient_entries
             (previous_patient_id, action, entered_by_user_id, entered_by_role, ip_address, user_agent, payload_json)
             VALUES (?, 'CREATE', ?, ?, ?, ?, ?)`,
            [
                previousPatientId,
                req.user.id,
                actorRole,
                actorIp,
                actorUserAgent,
                JSON.stringify(payload),
            ]
        );

        const [rows] = await connection.execute(
            `SELECT
                p.id AS previous_patient_id,
                p.full_name,
                p.patient_id,
                p.age,
                p.gender,
                p.mobile_no,
                p.email,
                p.address,
                p.description,
                p.fk_branch_id,
                p.entered_by_user_id,
                p.entered_by_role,
                actor.full_name AS entered_by_name,
                p.is_active,
                p.created_at,
                p.updated_at
             FROM tbl_previous_manual_patients p
             LEFT JOIN master_users actor ON actor.id = p.entered_by_user_id
             WHERE p.id = ?
             LIMIT 1`,
            [previousPatientId]
        );

        return rows[0];
    });

    return res.status(201).json({
        success: true,
        message: 'Previous patient recorded successfully',
        data: created,
    });
});

const listPreviousManualPatients = asyncHandler(async (req, res) => {
    const search = req.query.search ? String(req.query.search).trim() : null;
    const page = toPositiveInt(req.query.page) || 1;
    const requestedPageSize = toPositiveInt(req.query.page_size) || 20;
    const pageSize = Math.min(requestedPageSize, 100);
    const offset = (page - 1) * pageSize;

    const conditions = ['p.is_active = 1'];
    const params = [];

    if (search) {
        conditions.push(
            '(p.full_name LIKE ? OR p.patient_id LIKE ? OR p.mobile_no LIKE ? OR p.email LIKE ?)'
        );
        params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
    }

    const whereClause = `WHERE ${conditions.join(' AND ')}`;

    const [countRows, rows] = await Promise.all([
        query(
            `SELECT COUNT(*) AS total
             FROM tbl_previous_manual_patients p
             ${whereClause}`,
            params
        ),
        query(
            `SELECT
                p.id AS previous_patient_id,
                p.full_name,
                p.patient_id,
                p.age,
                p.gender,
                p.mobile_no,
                p.email,
                p.address,
                p.description,
                p.fk_branch_id,
                p.entered_by_user_id,
                p.entered_by_role,
                actor.full_name AS entered_by_name,
                p.is_active,
                p.created_at,
                p.updated_at
             FROM tbl_previous_manual_patients p
             LEFT JOIN master_users actor ON actor.id = p.entered_by_user_id
             ${whereClause}
             ORDER BY p.created_at DESC, p.id DESC
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
         FROM tbl_previous_manual_patients
         WHERE id = ?
         LIMIT 1`,
        [previousPatientId]
    );

    if (patients.length === 0) {
        throw new AppError('Previous patient not found', 404);
    }

    const logs = await query(
        `SELECT
            l.id,
            l.previous_patient_id,
            l.action,
            l.entered_by_user_id,
            l.entered_by_role,
            actor.full_name AS entered_by_name,
            l.ip_address,
            l.payload_json,
            l.created_at
         FROM log_previous_manual_patient_entries l
         LEFT JOIN master_users actor ON actor.id = l.entered_by_user_id
         WHERE l.previous_patient_id = ?
         ORDER BY l.created_at DESC, l.id DESC`,
        [previousPatientId]
    );

    const data = logs.map((row) => ({
        ...row,
        payload:
            typeof row.payload_json === 'string'
                ? (() => {
                      try {
                          return JSON.parse(row.payload_json);
                      } catch {
                          return null;
                      }
                  })()
                : row.payload_json || null,
        payload_json: undefined,
    }));

    return res.status(200).json({
        success: true,
        message: 'Previous patient entry logs fetched successfully',
        data,
        meta: {
            previous_patient_id: previousPatientId,
            total: data.length,
        },
    });
});

module.exports = {
    createPreviousManualPatient,
    listPreviousManualPatients,
    getPreviousManualPatientEntryLogs,
};
