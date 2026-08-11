const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { randomUUID, createHash } = require('crypto');
const { query, withTransaction } = require('../../config/db');
const { env } = require('../../config/env');
const AppError = require('../../utils/AppError');
const asyncHandler = require('../../utils/asyncHandler');
const { normalizeRole, normalizeRoleCode, getRoleMeta } = require('../../utils/roles');
const { getModuleAccessFromUser } = require('../../utils/moduleAccess');
const { isBranchScopedRole } = require('../../utils/branchScope');
const { sendRegistrationWelcomeWhatsApp } = require('../../utils/whatsappService');
const { generateOtp } = require('../../utils/otp');

const getClientIp = (req) => {
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) {
        return forwarded.split(',')[0].trim();
    }

    return req.ip || req.socket?.remoteAddress || '0.0.0.0';
};

const getDefaultLanguage = async () => {
    const languages = await query(
        'SELECT id, code, name FROM master_languages WHERE is_active = 1 ORDER BY id ASC LIMIT 1'
    );

    return languages[0] || null;
};

const validateGender = (gender) => ['male', 'female', 'other'].includes(String(gender || '').toLowerCase());
const validateMobile = (mobileNo) => /^[0-9]{10,15}$/.test(String(mobileNo || '').trim());
const PROFILE_AUDIT_FIELDS = ['full_name', 'age', 'gender', 'email', 'address', 'description', 'mobile_no'];

const validateEmail = (email) => {
    if (!email) {
        return true;
    }

    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email).trim());
};

const formatPatientRegistrationDate = (date = new Date()) => {
    const day = String(date.getDate()).padStart(2, '0');
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const year = String(date.getFullYear());

    return `${day}${month}${year}`;
};

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

const otpExpiresInSec = env.otp.expiresInSec;
const otpResendIntervalSec = env.otp.resendIntervalSec;
const accessTokenExpiresIn = env.accessTokenExpiresIn;
const refreshTokenExpiresIn = env.refreshTokenExpiresIn;

const getAccessTokenSecret = () => env.jwtSecret;
const getRegistrationTokenSecret = () => env.registrationTokenSecret;
const getForgotPasswordTokenSecret = () => env.forgotPasswordTokenSecret;

const generateOtpForCurrentEnvironment = () => generateOtp({
    nodeEnv: env.nodeEnv,
    defaultOtp: env.otp.defaultOtp,
    useDefaultInProduction: env.otp.useDefaultInProduction,
});

const sendOtpToMobile = async (mobileNo, otp) => {
    // Replace this with a real SMS gateway integration in production.
    console.log(`Sending OTP ${otp} to ${mobileNo}`);
};

const getRolePayload = (value) => {
    const roleMeta = getRoleMeta(value);

    return {
        role: roleMeta.role || 'patient',
        role_code: roleMeta.role_code || 'PAT',
    };
};

const signAccessToken = (patient, tokenJti = randomUUID()) => {
    const rolePayload = getRolePayload(patient.role_code || patient.role);

    const token = jwt.sign(
        {
            id: patient.id,
            uuid: patient.uuid,
            mobile_no: patient.mobile_no,
            role: rolePayload.role,
            role_code: rolePayload.role_code,
            jti: tokenJti,
            type: 'access',
        },
        getAccessTokenSecret(),
        { expiresIn: accessTokenExpiresIn }
    );

    return {
        token,
        jti: tokenJti,
    };
};

const signRefreshToken = (patient, tokenJti = randomUUID()) => {
    const rolePayload = getRolePayload(patient.role_code || patient.role);

    const token = jwt.sign(
        {
            id: patient.id,
            uuid: patient.uuid,
            mobile_no: patient.mobile_no,
            role: rolePayload.role,
            role_code: rolePayload.role_code,
            jti: tokenJti,
            type: 'refresh',
        },
        getAccessTokenSecret(),
        { expiresIn: refreshTokenExpiresIn }
    );

    return {
        token,
        jti: tokenJti,
    };
};

const signRegistrationToken = (payload, expiresIn) => jwt.sign(payload, getRegistrationTokenSecret(), { expiresIn });
const verifyRegistrationToken = (token) => jwt.verify(token, getRegistrationTokenSecret());

const signForgotPasswordToken = (payload, expiresIn) => jwt.sign(payload, getForgotPasswordTokenSecret(), { expiresIn });
const verifyForgotPasswordToken = (token) => jwt.verify(token, getForgotPasswordTokenSecret());
const hashToken = (token) => createHash('sha256').update(String(token)).digest('hex');

const listAccessibleBranchesForUser = async (userId) => query(
    `SELECT b.id, b.branch_name, b.address, b.contact_no
     FROM tbl_user_branch_access uba
     JOIN master_clinic_branches b ON b.id = uba.branch_id
     WHERE uba.user_id = ?
       AND uba.is_active = 1
       AND b.is_active = 1
     ORDER BY b.branch_name ASC, b.id ASC`,
    [userId]
);

const buildBranchScopeDataForUser = async (userId) => {
    const userRows = await query(
        `SELECT u.id,
                u.selected_branch_id,
                b.branch_name,
                b.address,
                b.contact_no,
                b.is_active
         FROM master_users u
         LEFT JOIN master_clinic_branches b ON b.id = u.selected_branch_id
         WHERE u.id = ?
         LIMIT 1`,
        [userId]
    );

    if (userRows.length === 0) {
        return {
            required: false,
            selected_branch_id: null,
            selected_branch: null,
            available_branches: [],
        };
    }

    const user = userRows[0];
    const availableBranches = await listAccessibleBranchesForUser(userId);
    const selectedBranchIsActive = Number(user.is_active) === 1
        && availableBranches.some((branch) => Number(branch.id) === Number(user.selected_branch_id));
    const selectedBranch = user.selected_branch_id && selectedBranchIsActive
        ? {
            id: Number(user.selected_branch_id),
            branch_name: user.branch_name,
            address: user.address,
            contact_no: user.contact_no,
        }
        : null;

    return {
        required: true,
        selected_branch_id: selectedBranch ? selectedBranch.id : null,
        selected_branch: selectedBranch,
        available_branches: availableBranches.map((branch) => ({
            id: Number(branch.id),
            branch_name: branch.branch_name,
            address: branch.address,
            contact_no: branch.contact_no,
            is_selected: selectedBranch ? Number(branch.id) === selectedBranch.id : false,
        })),
    };
};

const buildAuthData = async ({ patient, languageId, token, refreshToken = null, oldToken = null }) => {
    const normalizedPatient = patient
        ? {
            ...patient,
            role: normalizeRole(patient.role_code || patient.role) || null,
            role_code: normalizeRoleCode(patient.role_code || patient.role) || null,
            ...getModuleAccessFromUser(patient),
        }
        : null;

    const branchScope = normalizedPatient && isBranchScopedRole(normalizedPatient)
        ? await buildBranchScopeDataForUser(normalizedPatient.id)
        : {
            required: false,
            selected_branch_id: null,
            selected_branch: null,
            available_branches: [],
        };

    return {
        token,
        token_type: 'Bearer',
        ...(refreshToken ? { refresh_token: refreshToken } : {}),
        language_id: languageId || null,
        patient: normalizedPatient,
        branch_scope: branchScope,
        ...(oldToken ? { old_token: oldToken } : {}),
    };
};

const issueAuthTokens = async ({ patient, req }) => {
    const signedAccess = signAccessToken(patient);
    const signedRefresh = signRefreshToken(patient);
    const decodedRefresh = jwt.decode(signedRefresh.token);

    await query(
        `INSERT INTO tbl_user_refresh_tokens
         (patient_id, token_jti, token_hash, expires_at, created_ip, user_agent)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
            patient.id,
            signedRefresh.jti,
            hashToken(signedRefresh.token),
            new Date(Number(decodedRefresh.exp) * 1000),
            req ? getClientIp(req) : null,
            req?.headers?.['user-agent'] || null,
        ]
    );

    return {
        token: signedAccess.token,
        refresh_token: signedRefresh.token,
    };
};

const revokeAllRefreshTokensForPatient = async (patientId) => {
    await query(
        `UPDATE tbl_user_refresh_tokens
         SET revoked_at = COALESCE(revoked_at, NOW())
         WHERE patient_id = ? AND revoked_at IS NULL`,
        [patientId]
    );
};

const recordPatientLogin = async ({ patientId, languageId, loginMethod, req }) => {
    await query(
        `INSERT INTO log_user_logins
         (patient_id, language_id, login_method, login_ip, user_agent)
         VALUES (?, ?, ?, ?, ?)`,
        [
            patientId,
            languageId,
            loginMethod,
            getClientIp(req),
            req.headers['user-agent'] || null,
        ]
    );
};

const recordPatientProfileUpdate = async (connection, {
    userId,
    changedByUserId = null,
    changedByRole = null,
    ipAddress = null,
    userAgent = null,
    changedFields,
    previousValues,
    nextValues,
}) => {
    await connection.execute(
        `INSERT INTO log_user_profile_updates
         (user_id, changed_by_user_id, changed_by_role, ip_address, user_agent, changed_fields_json, old_values_json, new_values_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            userId,
            changedByUserId,
            changedByRole,
            ipAddress,
            userAgent,
            JSON.stringify(changedFields),
            JSON.stringify(previousValues),
            JSON.stringify(nextValues),
        ]
    );
};

const getOtpPurposeConfig = (purpose) => {
    if (purpose === 'register') {
        return {
            sessionPurpose: 'register_otp_session',
            signSessionToken: signRegistrationToken,
            verifySessionToken: verifyRegistrationToken,
            invalidSessionMessage: 'Invalid or expired OTP session token',
            invalidOtpMessage: 'Invalid registration OTP',
        };
    }

    if (purpose === 'forgot_password') {
        return {
            sessionPurpose: 'forgot_password_otp_session',
            signSessionToken: signForgotPasswordToken,
            verifySessionToken: verifyForgotPasswordToken,
            invalidSessionMessage: 'Invalid or expired OTP session token',
            invalidOtpMessage: 'Invalid OTP',
        };
    }

    throw new Error(`Unsupported OTP purpose: ${purpose}`);
};

const normalizeOptionalText = (value) => {
    if (value === undefined || value === null) {
        return null;
    }

    const normalizedValue = String(value).trim();
    return normalizedValue ? normalizedValue : null;
};

const buildProfileAuditSnapshot = (userRow) => ({
    full_name: userRow?.full_name ?? null,
    age: userRow?.age === undefined || userRow?.age === null ? null : Number(userRow.age),
    gender: userRow?.gender ?? null,
    email: userRow?.email ?? null,
    address: userRow?.address ?? null,
    description: userRow?.description ?? null,
    mobile_no: userRow?.mobile_no ?? null,
});

const buildProfileAuditChangeSet = (previousSnapshot, nextSnapshot) => {
    const changedFields = [];
    const previousValues = {};
    const nextValues = {};

    PROFILE_AUDIT_FIELDS.forEach((field) => {
        if (previousSnapshot[field] === nextSnapshot[field]) {
            return;
        }

        changedFields.push(field);
        previousValues[field] = previousSnapshot[field];
        nextValues[field] = nextSnapshot[field];
    });

    return {
        changedFields,
        previousValues,
        nextValues,
    };
};

const createOtpSessionToken = ({ purpose, mobileNo, otpId, patientId = null }) => {
    const config = getOtpPurposeConfig(purpose);

    return config.signSessionToken(
        {
            purpose: config.sessionPurpose,
            otp_id: otpId,
            patient_id: patientId,
            mobile_no: mobileNo,
        },
        `${otpExpiresInSec}s`
    );
};

const requestOtpRecord = async ({ purpose, mobileNo, patientId = null }) => {
    const normalizedMobileNo = String(mobileNo).trim();

    const latestOtpRows = await query(
        `SELECT id, resend_available_at
         FROM tbl_user_otps
         WHERE mobile_no = ? AND purpose = ? AND is_used = 0
         ORDER BY id DESC
         LIMIT 1`,
        [normalizedMobileNo, purpose]
    );

    if (latestOtpRows.length > 0) {
        const resendAt = new Date(latestOtpRows[0].resend_available_at).getTime();
        const retryAfter = Math.ceil((resendAt - Date.now()) / 1000);

        if (retryAfter > 0) {
            throw new AppError('Please wait before requesting OTP again', 429, {
                retry_after_seconds: retryAfter,
            });
        }
    }

    const otp = generateOtpForCurrentEnvironment();
    const otpHash = await bcrypt.hash(otp, 10);

    const result = await query(
        `INSERT INTO tbl_user_otps
         (patient_id, mobile_no, otp_hash, purpose, expires_at, resend_available_at)
         VALUES (?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL ? SECOND), DATE_ADD(NOW(), INTERVAL ? SECOND))`,
        [patientId, normalizedMobileNo, otpHash, purpose, otpExpiresInSec, otpResendIntervalSec]
    );

    return {
        otp,
        otpId: result.insertId,
        mobileNo: normalizedMobileNo,
    };
};

const verifyOtpFromSessionToken = async ({ purpose, mobileNo, otp, otpSessionToken }) => {
    const normalizedMobileNo = String(mobileNo).trim();
    const config = getOtpPurposeConfig(purpose);

    let sessionPayload;
    try {
        sessionPayload = config.verifySessionToken(otpSessionToken);
    } catch (error) {
        throw new AppError(config.invalidSessionMessage, 401);
    }

    if (sessionPayload.purpose !== config.sessionPurpose) {
        throw new AppError('Invalid OTP session token purpose', 401);
    }

    if (String(sessionPayload.mobile_no).trim() !== normalizedMobileNo) {
        throw new AppError('OTP session token does not match the provided mobile number', 400);
    }

    const otpRows = await query(
        `SELECT id, patient_id, mobile_no, otp_hash, expires_at, attempt_count, is_used
         FROM tbl_user_otps
         WHERE id = ? AND purpose = ?
         LIMIT 1`,
        [Number(sessionPayload.otp_id), purpose]
    );

    if (otpRows.length === 0) {
        throw new AppError(config.invalidSessionMessage, 401);
    }

    const activeOtp = otpRows[0];

    if (activeOtp.is_used) {
        throw new AppError('OTP session is already used. Please request a new OTP.', 410);
    }

    if (String(activeOtp.mobile_no).trim() !== normalizedMobileNo) {
        throw new AppError('OTP record does not match the provided mobile number', 400);
    }

    if (new Date(activeOtp.expires_at).getTime() < Date.now()) {
        throw new AppError('OTP expired. Please request a new OTP.', 410);
    }

    if (activeOtp.attempt_count >= 5) {
        throw new AppError('Too many invalid OTP attempts. Please request a new OTP.', 429);
    }

    const isOtpValid = await bcrypt.compare(String(otp), activeOtp.otp_hash);

    if (!isOtpValid) {
        await query(
            'UPDATE tbl_user_otps SET attempt_count = attempt_count + 1 WHERE id = ?',
            [activeOtp.id]
        );
        throw new AppError(config.invalidOtpMessage, 401);
    }

    await query(
        'UPDATE tbl_user_otps SET is_used = 1, verified_at = NOW() WHERE id = ?',
        [activeOtp.id]
    );

    return activeOtp;
};

const findActivePatientByMobile = async (mobileNo) => {
    const patients = await query(
        `SELECT id, uuid, full_name, age, gender, email, address, description, mobile_no, password, role,
                COALESCE(has_cross_module_access, 0) AS has_cross_module_access,
                is_active, created_at, updated_at
         FROM master_users
         WHERE mobile_no = ?
         LIMIT 1`,
        [String(mobileNo).trim()]
    );

    if (patients.length === 0) {
        throw new AppError('Patient not found with this mobile number', 404);
    }

    const patient = patients[0];

    if (!patient.is_active) {
        throw new AppError('Patient account is inactive', 403);
    }

    return patient;
};

const requestRegistrationOtp = asyncHandler(async (req, res) => {
    const { mobile_no } = req.body;

    if (!mobile_no) {
        throw new AppError('mobile_no is required', 400);
    }

    if (!validateMobile(mobile_no)) {
        throw new AppError('mobile_no must be 10 to 15 digits', 400);
    }

    const existingPatients = await query(
        'SELECT id FROM master_users WHERE mobile_no = ? LIMIT 1',
        [String(mobile_no).trim()]
    );

    if (existingPatients.length > 0) {
        throw new AppError('Mobile number already registered', 409);
    }

    const otpRecord = await requestOtpRecord({
        purpose: 'register',
        mobileNo: mobile_no,
        patientId: null,
    });
    const otpSessionToken = createOtpSessionToken({
        purpose: 'register',
        mobileNo: otpRecord.mobileNo,
        otpId: otpRecord.otpId,
    });

    await sendOtpToMobile(otpRecord.mobileNo, otpRecord.otp);

    const response = {
        success: true,
        message: 'Registration OTP sent to mobile number. Use it to verify your mobile before completing registration.',
        data: {
            mobile_no: otpRecord.mobileNo,
            otp_session_token: otpSessionToken,
        },
    };

    if (env.nodeEnv !== 'production') {
        response.data.default_otp = otpRecord.otp;
    }

    return res.status(200).json(response);
});

const verifyRegistrationOtp = asyncHandler(async (req, res) => {
    const { mobile_no, otp, otp_session_token } = req.body;

    if (!mobile_no || !otp || !otp_session_token) {
        throw new AppError('mobile_no, otp and otp_session_token are required', 400);
    }

    if (!validateMobile(mobile_no)) {
        throw new AppError('mobile_no must be 10 to 15 digits', 400);
    }

    const verifiedOtpRecord = await verifyOtpFromSessionToken({
        purpose: 'register',
        mobileNo: mobile_no,
        otp,
        otpSessionToken: otp_session_token,
    });

    const registrationVerifiedToken = signRegistrationToken(
        {
            purpose: 'register_verified',
            mobile_no: String(verifiedOtpRecord.mobile_no).trim(),
        },
        `${otpExpiresInSec * 2}s`
    );

    return res.status(200).json({
        success: true,
        message: 'Registration OTP verified. Use the returned verified token to complete registration.',
        data: {
            mobile_no: String(mobile_no).trim(),
            registration_token: registrationVerifiedToken,
        },
    });
});

const registerUser = asyncHandler(async (req, res) => {
    const {
        full_name,
        age,
        gender,
        email = null,
        address,
        mobile_no,
        password,
        registration_token,
    } = req.body;

    if (!full_name || age === undefined || !gender || !mobile_no || !password || !registration_token) {
        throw new AppError('full_name, age, gender, mobile_no, password and registration_token are required', 400);
    }

    if (email !== null && !validateEmail(email)) {
        throw new AppError('email must be a valid email address', 400);
    }

    const parsedAge = Number(age);

    if (!Number.isInteger(parsedAge) || parsedAge < 1 || parsedAge > 120) {
        throw new AppError('age must be a valid number between 1 and 120', 400);
    }

    if (!validateGender(gender)) {
        throw new AppError("gender must be one of: 'male', 'female', 'other'", 400);
    }

    if (!validateMobile(mobile_no)) {
        throw new AppError('mobile_no must be 10 to 15 digits', 400);
    }

    if (String(password).length < 6) {
        throw new AppError('Password must be at least 6 characters', 400);
    }

    let registrationPayload;
    try {
        registrationPayload = verifyRegistrationToken(registration_token);
    } catch (error) {
        throw new AppError('Invalid or expired registration token', 401);
    }

    if (registrationPayload.purpose !== 'register_verified') {
        throw new AppError('Invalid registration token purpose', 401);
    }

    if (String(registrationPayload.mobile_no).trim() !== String(mobile_no).trim()) {
        throw new AppError('Registration token does not match the provided mobile number', 400);
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const ip = getClientIp(req);
    const normalizedMobileNo = String(mobile_no).trim();
    const normalizedEmail = normalizeOptionalText(email);
    const normalizedAddress = normalizeOptionalText(address);

    const result = await withTransaction(async (connection) => {
        const [existingPatients] = await connection.execute(
            'SELECT id FROM master_users WHERE mobile_no = ? LIMIT 1',
            [normalizedMobileNo]
        );

        if (existingPatients.length > 0) {
            throw new AppError('Mobile number already registered', 409);
        }

        if (normalizedEmail) {
            const [existingEmail] = await connection.execute(
                'SELECT id FROM master_users WHERE email = ? LIMIT 1',
                [normalizedEmail]
            );

            if (existingEmail.length > 0) {
                throw new AppError('Email already registered', 409);
            }
        }

        const patientUuid = await generateTodayPatientUuid(connection);

        const [insertResult] = await connection.execute(
            `INSERT INTO master_users
             (uuid, full_name, age, gender, email, address, mobile_no, password, role, created_by, updated_by, created_ip, updated_ip)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PAT', NULL, NULL, ?, ?)`,
            [
                patientUuid,
                String(full_name).trim(),
                parsedAge,
                String(gender).toLowerCase(),
                normalizedEmail,
                normalizedAddress,
                normalizedMobileNo,
                hashedPassword,
                ip,
                ip,
            ]
        );

        return insertResult;
    });

    const patientRows = await query(
        `SELECT id, uuid, full_name, age, gender, email, address, description, mobile_no, role,
                COALESCE(has_cross_module_access, 0) AS has_cross_module_access,
                is_active, created_at, updated_at
         FROM master_users
         WHERE id = ?
         LIMIT 1`,
        [result.insertId]
    );

    const patient = patientRows[0];
    const issuedTokens = await issueAuthTokens({ patient, req });

    try {
        await sendRegistrationWelcomeWhatsApp({ mobileNo: patient.mobile_no });
    } catch (error) {
        console.error(
            `Failed to send registration welcome WhatsApp to ${patient.mobile_no}: ${error.message}`
        );
    }

    return res.status(201).json({
        success: true,
        message: 'User registered successfully',
        data: await buildAuthData({
            patient,
            languageId: null,
            token: issuedTokens.token,
            refreshToken: issuedTokens.refresh_token,
        }),
    });
});

const login = asyncHandler(async (req, res) => {
    const { mobile_no, password } = req.body;

    if (!mobile_no || !password) {
        throw new AppError('mobile_no and password are required', 400);
    }

    const language = await getDefaultLanguage();

    if (!language) {
        throw new AppError('No active language configured', 500);
    }

    const patient = await findActivePatientByMobile(mobile_no);
    const isPasswordValid = await bcrypt.compare(password, patient.password);

    if (!isPasswordValid) {
        throw new AppError('Invalid mobile number or password', 401);
    }

    await recordPatientLogin({
        patientId: patient.id,
        languageId: language.id,
        loginMethod: 'password',
        req,
    });

    const issuedTokens = await issueAuthTokens({ patient, req });

    return res.status(200).json({
        success: true,
        message: 'Login successful',
        data: await buildAuthData({
            patient: {
                id: patient.id,
                uuid: patient.uuid,
                full_name: patient.full_name,
                age: patient.age,
                gender: patient.gender,
                email: patient.email,
                address: patient.address,
                description: patient.description,
                mobile_no: patient.mobile_no,
                role: patient.role,
                has_cross_module_access: patient.has_cross_module_access,
                is_active: patient.is_active,
                created_at: patient.created_at,
                updated_at: patient.updated_at,
            },
            languageId: language.id,
            token: issuedTokens.token,
            refreshToken: issuedTokens.refresh_token,
        }),
    });
});

const requestLoginOtp = asyncHandler(async (req, res) => {
    const { mobile_no } = req.body;

    if (!mobile_no) {
        throw new AppError('mobile_no is required', 400);
    }

    if (!validateMobile(mobile_no)) {
        throw new AppError('mobile_no must be 10 to 15 digits', 400);
    }

    const patient = await findActivePatientByMobile(mobile_no);

    const latestOtpRows = await query(
        `SELECT id, resend_available_at
         FROM tbl_user_otps
         WHERE patient_id = ? AND mobile_no = ? AND purpose = 'login' AND is_used = 0
         ORDER BY id DESC
         LIMIT 1`,
        [patient.id, patient.mobile_no]
    );

    if (latestOtpRows.length > 0) {
        const resendAt = new Date(latestOtpRows[0].resend_available_at).getTime();
        const retryAfter = Math.ceil((resendAt - Date.now()) / 1000);

        if (retryAfter > 0) {
            throw new AppError('Please wait before requesting OTP again', 429, {
                retry_after_seconds: retryAfter,
            });
        }
    }

    const otp = generateOtpForCurrentEnvironment();
    const otpHash = await bcrypt.hash(otp, 10);

    await query(
        `INSERT INTO tbl_user_otps
         (patient_id, mobile_no, otp_hash, purpose, expires_at, resend_available_at)
         VALUES (?, ?, ?, 'login', DATE_ADD(NOW(), INTERVAL ? SECOND), DATE_ADD(NOW(), INTERVAL ? SECOND))`,
        [patient.id, patient.mobile_no, otpHash, otpExpiresInSec, otpResendIntervalSec]
    );

    await sendOtpToMobile(patient.mobile_no, otp);

    const response = {
        success: true,
        message: 'OTP sent successfully',
        data: {
            mobile_no: patient.mobile_no,
            resend_after_seconds: otpResendIntervalSec,
        },
    };

    if (env.nodeEnv !== 'production') {
        response.data.default_otp = otp;
    }

    return res.status(200).json(response);
});

const verifyLoginOtp = asyncHandler(async (req, res) => {
    const { mobile_no, otp } = req.body;

    if (!mobile_no || !otp) {
        throw new AppError('mobile_no and otp are required', 400);
    }

    if (!validateMobile(mobile_no)) {
        throw new AppError('mobile_no must be 10 to 15 digits', 400);
    }

    const language = await getDefaultLanguage();

    if (!language) {
        throw new AppError('No active language configured', 500);
    }

    const patient = await findActivePatientByMobile(mobile_no);

    const otpRows = await query(
        `SELECT id, otp_hash, expires_at, attempt_count
         FROM tbl_user_otps
         WHERE patient_id = ? AND mobile_no = ? AND purpose = 'login' AND is_used = 0
         ORDER BY id DESC
         LIMIT 1`,
        [patient.id, patient.mobile_no]
    );

    if (otpRows.length === 0) {
        throw new AppError('No active OTP found. Please request OTP first.', 404);
    }

    const activeOtp = otpRows[0];

    if (new Date(activeOtp.expires_at).getTime() < Date.now()) {
        throw new AppError('OTP expired. Please request a new OTP.', 410);
    }

    if (activeOtp.attempt_count >= 5) {
        throw new AppError('Too many invalid OTP attempts. Please request a new OTP.', 429);
    }

    const isOtpValid = await bcrypt.compare(String(otp), activeOtp.otp_hash);

    if (!isOtpValid) {
        await query(
            'UPDATE tbl_user_otps SET attempt_count = attempt_count + 1 WHERE id = ?',
            [activeOtp.id]
        );
        throw new AppError('Invalid OTP', 401);
    }

    await query(
        'UPDATE tbl_user_otps SET is_used = 1, verified_at = NOW() WHERE id = ?',
        [activeOtp.id]
    );

    await recordPatientLogin({
        patientId: patient.id,
        languageId: language.id,
        loginMethod: 'otp',
        req,
    });

    const issuedTokens = await issueAuthTokens({ patient, req });

    return res.status(200).json({
        success: true,
        message: 'OTP login successful',
        data: await buildAuthData({
            patient: {
                id: patient.id,
                uuid: patient.uuid,
                full_name: patient.full_name,
                age: patient.age,
                gender: patient.gender,
                email: patient.email,
                address: patient.address,
                description: patient.description,
                mobile_no: patient.mobile_no,
                role: patient.role,
                has_cross_module_access: patient.has_cross_module_access,
                is_active: patient.is_active,
                created_at: patient.created_at,
                updated_at: patient.updated_at,
            },
            languageId: language.id,
            token: issuedTokens.token,
            refreshToken: issuedTokens.refresh_token,
        }),
    });
});

const getCurrentPatient = asyncHandler(async (req, res) => {
    const users = await query(
        `SELECT id, uuid, full_name, age, gender, email, address, description, mobile_no, role,
                COALESCE(has_cross_module_access, 0) AS has_cross_module_access,
                is_active, created_at, updated_at
         FROM master_users
         WHERE id = ?
         LIMIT 1`,
        [req.user.id]
    );

    if (users.length === 0) {
        throw new AppError('User not found', 404);
    }

    const user = {
        ...users[0],
        role: normalizeRole(users[0].role) || null,
        role_code: normalizeRoleCode(users[0].role) || null,
        ...getModuleAccessFromUser(users[0]),
    };

    const branchScope = isBranchScopedRole(user)
        ? await buildBranchScopeDataForUser(user.id)
        : {
            required: false,
            selected_branch_id: null,
            selected_branch: null,
            available_branches: [],
        };

    return res.status(200).json({
        success: true,
        message: 'Authenticated user profile fetched',
        data: {
            ...user,
            branch_scope: branchScope,
        },
    });
});

const listSelectableBranches = asyncHandler(async (req, res) => {
    if (!isBranchScopedRole(req.user)) {
        return res.status(200).json({
            success: true,
            message: 'Branch selection is not required for this role',
            data: {
                required: false,
                selected_branch_id: null,
                selected_branch: null,
                available_branches: [],
            },
        });
    }

    return res.status(200).json({
        success: true,
        message: 'Selectable branches fetched successfully',
        data: await buildBranchScopeDataForUser(req.user.id),
    });
});

const selectCurrentBranch = asyncHandler(async (req, res) => {
    if (!isBranchScopedRole(req.user)) {
        throw new AppError('Branch selection is supported only for doctor, receptionist and medical roles', 403);
    }

    const branchId = Number(req.body?.branch_id);

    if (!Number.isInteger(branchId) || branchId <= 0) {
        throw new AppError('branch_id must be a positive integer', 400);
    }

    const branchRows = await query(
        `SELECT b.id
         FROM tbl_user_branch_access uba
         JOIN master_clinic_branches b ON b.id = uba.branch_id
         WHERE uba.user_id = ?
           AND uba.branch_id = ?
           AND uba.is_active = 1
           AND b.is_active = 1
         LIMIT 1`,
        [req.user.id, branchId]
    );

    if (branchRows.length === 0) {
        throw new AppError('Selected branch is not assigned to this user or is inactive', 403);
    }

    await query(
        `UPDATE master_users
         SET selected_branch_id = ?,
             updated_by = ?,
             updated_ip = ?
         WHERE id = ?`,
        [branchId, req.user.id, getClientIp(req), req.user.id]
    );

    return res.status(200).json({
        success: true,
        message: 'Selected branch updated successfully',
        data: await buildBranchScopeDataForUser(req.user.id),
    });
});

const updateCurrentPatientProfile = asyncHandler(async (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};

    const {
        full_name: fullNameSnake,
        fullName: fullNameCamel,
        email,
        address,
        age,
        gender,
        description,
        mobile_no: mobileNoSnake,
        mobileNo: mobileNoCamel,
    } = body;

    const full_name = fullNameSnake ?? fullNameCamel;
    const mobile_no = mobileNoSnake ?? mobileNoCamel;

    if (
        full_name === undefined
        && email === undefined
        && address === undefined
        && age === undefined
        && gender === undefined
        && description === undefined
        && mobile_no === undefined
    ) {
        throw new AppError('At least one field is required to update profile', 400);
    }

    const updateParts = [];
    const values = [];
    const actorIp = getClientIp(req);
    const actorRole = req.user?.role_code || req.user?.role || null;
    const actorUserAgent = req.headers['user-agent'] || null;

    if (full_name !== undefined) {
        if (!String(full_name).trim()) {
            throw new AppError('full_name cannot be empty', 400);
        }
        updateParts.push('full_name = ?');
        values.push(String(full_name).trim());
    }

    if (age !== undefined) {
        const parsedAge = Number(age);
        if (!Number.isInteger(parsedAge) || parsedAge < 1 || parsedAge > 120) {
            throw new AppError('age must be a valid number between 1 and 120', 400);
        }
        updateParts.push('age = ?');
        values.push(parsedAge);
    }

    const updatedPatient = await withTransaction(async (connection) => {
        const [existingUserRows] = await connection.execute(
            `SELECT id, uuid, full_name, age, gender, email, address, description, mobile_no, role, is_active, created_at, updated_at
             FROM master_users
             WHERE id = ?
             LIMIT 1
             FOR UPDATE`,
            [req.user.id]
        );

        if (existingUserRows.length === 0) {
            throw new AppError('User not found', 404);
        }

        const existingUser = existingUserRows[0];

        if (email !== undefined) {
            if (email !== null && String(email).trim() !== '' && !validateEmail(email)) {
                throw new AppError('email must be a valid email address', 400);
            }

            if (email !== null && String(email).trim() !== '') {
                const [existingEmailUserRows] = await connection.execute(
                    'SELECT id FROM master_users WHERE email = ? AND id != ? LIMIT 1',
                    [String(email).trim(), req.user.id]
                );

                if (existingEmailUserRows.length > 0) {
                    throw new AppError('Email already in use by another user', 409);
                }
            }

            updateParts.push('email = ?');
            values.push(normalizeOptionalText(email));
        }

        if (address !== undefined) {
            updateParts.push('address = ?');
            values.push(normalizeOptionalText(address));
        }

        if (gender !== undefined) {
            if (!validateGender(gender)) {
                throw new AppError("gender must be one of: 'male', 'female', 'other'", 400);
            }
            updateParts.push('gender = ?');
            values.push(String(gender).toLowerCase());
        }

        if (description !== undefined) {
            updateParts.push('description = ?');
            values.push(description ? String(description).trim() : null);
        }

        if (mobile_no !== undefined) {
            if (!validateMobile(mobile_no)) {
                throw new AppError('mobile_no must be 10 to 15 digits', 400);
            }

            const [existingPatientRows] = await connection.execute(
                'SELECT id FROM master_users WHERE mobile_no = ? AND id != ? LIMIT 1',
                [String(mobile_no).trim(), req.user.id]
            );

            if (existingPatientRows.length > 0) {
                throw new AppError('Mobile number already in use by another patient', 409);
            }

            updateParts.push('mobile_no = ?');
            values.push(String(mobile_no).trim());
        }

        updateParts.push('updated_by = ?');
        values.push(req.user.id);

        updateParts.push('updated_ip = ?');
        values.push(actorIp);

        values.push(req.user.id);

        await connection.execute(
            `UPDATE master_users
             SET ${updateParts.join(', ')}
             WHERE id = ?`,
            values
        );

        const [updatedPatientRows] = await connection.execute(
            `SELECT id, uuid, full_name, age, gender, email, address, description, mobile_no, role, is_active, created_at, updated_at
             FROM master_users
             WHERE id = ?
             LIMIT 1`,
            [req.user.id]
        );

        const previousSnapshot = buildProfileAuditSnapshot(existingUser);
        const nextSnapshot = buildProfileAuditSnapshot(updatedPatientRows[0]);
        const profileChangeSet = buildProfileAuditChangeSet(previousSnapshot, nextSnapshot);

        if (profileChangeSet.changedFields.length > 0) {
            await recordPatientProfileUpdate(connection, {
                userId: req.user.id,
                changedByUserId: req.user.id,
                changedByRole: actorRole,
                ipAddress: actorIp,
                userAgent: actorUserAgent,
                changedFields: profileChangeSet.changedFields,
                previousValues: profileChangeSet.previousValues,
                nextValues: profileChangeSet.nextValues,
            });
        }

        return {
            ...updatedPatientRows[0],
            role: normalizeRole(updatedPatientRows[0].role) || null,
            role_code: normalizeRoleCode(updatedPatientRows[0].role) || null,
        };
    });

    return res.status(200).json({
        success: true,
        message: 'User profile updated successfully',
        data: updatedPatient,
    });
});

const requestForgotPasswordOtp = asyncHandler(async (req, res) => {
    const { mobile_no } = req.body;

    if (!mobile_no) {
        throw new AppError('mobile_no is required', 400);
    }

    if (!validateMobile(mobile_no)) {
        throw new AppError('mobile_no must be 10 to 15 digits', 400);
    }

    const patient = await findActivePatientByMobile(mobile_no);

    const otpRecord = await requestOtpRecord({
        purpose: 'forgot_password',
        mobileNo: patient.mobile_no,
        patientId: patient.id,
    });
    const otpSessionToken = createOtpSessionToken({
        purpose: 'forgot_password',
        mobileNo: patient.mobile_no,
        otpId: otpRecord.otpId,
        patientId: patient.id,
    });

    await sendOtpToMobile(patient.mobile_no, otpRecord.otp);

    const response = {
        success: true,
        message: 'Forgot password OTP sent successfully',
        data: {
            mobile_no: patient.mobile_no,
            otp_session_token: otpSessionToken,
        },
    };

    if (env.nodeEnv !== 'production') {
        response.data.default_otp = otpRecord.otp;
    }

    return res.status(200).json(response);
});

const verifyForgotPasswordOtp = asyncHandler(async (req, res) => {
    const { mobile_no, otp, otp_session_token } = req.body;

    if (!mobile_no || !otp || !otp_session_token) {
        throw new AppError('mobile_no, otp and otp_session_token are required', 400);
    }

    if (!validateMobile(mobile_no)) {
        throw new AppError('mobile_no must be 10 to 15 digits', 400);
    }

    const verifiedOtpRecord = await verifyOtpFromSessionToken({
        purpose: 'forgot_password',
        mobileNo: mobile_no,
        otp,
        otpSessionToken: otp_session_token,
    });

    const passwordResetToken = signForgotPasswordToken(
        {
            purpose: 'forgot_password_reset',
            patient_id: Number(verifiedOtpRecord.patient_id),
            mobile_no: String(verifiedOtpRecord.mobile_no).trim(),
        },
        `${otpExpiresInSec * 2}s`
    );

    return res.status(200).json({
        success: true,
        message: 'OTP verified successfully. Use reset_token to set a new password.',
        data: {
            mobile_no: String(verifiedOtpRecord.mobile_no).trim(),
            reset_token: passwordResetToken,
        },
    });
});

const resetForgotPassword = asyncHandler(async (req, res) => {
    const { mobile_no, new_password, reset_token } = req.body;

    if (!mobile_no || !new_password || !reset_token) {
        throw new AppError('mobile_no, new_password and reset_token are required', 400);
    }

    if (!validateMobile(mobile_no)) {
        throw new AppError('mobile_no must be 10 to 15 digits', 400);
    }

    if (String(new_password).length < 6) {
        throw new AppError('new_password must be at least 6 characters', 400);
    }

    let resetPayload;
    try {
        resetPayload = verifyForgotPasswordToken(reset_token);
    } catch (error) {
        throw new AppError('Invalid or expired reset token', 401);
    }

    if (resetPayload.purpose !== 'forgot_password_reset') {
        throw new AppError('Invalid reset token purpose', 401);
    }

    if (String(resetPayload.mobile_no).trim() !== String(mobile_no).trim()) {
        throw new AppError('Reset token does not match the provided mobile number', 400);
    }

    const patientRows = await query(
        `SELECT id, mobile_no, is_active
         FROM master_users
         WHERE id = ? AND mobile_no = ?
         LIMIT 1`,
        [Number(resetPayload.patient_id), String(mobile_no).trim()]
    );

    if (patientRows.length === 0) {
        throw new AppError('Patient not found', 404);
    }

    const patient = patientRows[0];

    if (!patient.is_active) {
        throw new AppError('Patient account is inactive', 403);
    }

    const hashedPassword = await bcrypt.hash(String(new_password), 10);

    await query(
        `UPDATE master_users
         SET password = ?, updated_by = ?, updated_ip = ?
         WHERE id = ?`,
        [hashedPassword, patient.id, getClientIp(req), patient.id]
    );

    await revokeAllRefreshTokensForPatient(patient.id);

    return res.status(200).json({
        success: true,
        message: 'Password reset successful. Please login again.',
    });
});

const refreshToken = asyncHandler(async (req, res) => {
    const refreshTokenValue = req.body?.refresh_token || req.body?.token;

    if (!refreshTokenValue) {
        throw new AppError('refresh_token is required', 400);
    }

    let payload;
    try {
        payload = jwt.verify(refreshTokenValue, getAccessTokenSecret());
    } catch (error) {
        throw new AppError('Invalid or expired refresh token', 401);
    }

    if (payload.type !== 'refresh') {
        throw new AppError('Provided token is not a refresh token', 401);
    }

    const refreshTokenRows = await query(
        `SELECT id, patient_id, token_jti, token_hash, expires_at, revoked_at
         FROM tbl_user_refresh_tokens
         WHERE token_jti = ?
         LIMIT 1`,
        [payload.jti]
    );

    if (refreshTokenRows.length === 0) {
        throw new AppError('Refresh session not found. Please login again.', 401);
    }

    const storedRefreshToken = refreshTokenRows[0];

    if (storedRefreshToken.revoked_at) {
        throw new AppError('Refresh token has been revoked. Please login again.', 401);
    }

    if (hashToken(refreshTokenValue) !== storedRefreshToken.token_hash) {
        await revokeAllRefreshTokensForPatient(storedRefreshToken.patient_id);
        throw new AppError('Refresh token mismatch detected. Please login again.', 401);
    }

    if (new Date(storedRefreshToken.expires_at).getTime() < Date.now()) {
        throw new AppError('Refresh token expired. Please login again.', 401);
    }

    const patients = await query(
        `SELECT id, uuid, full_name, age, gender, email, address, description, mobile_no, role, is_active, created_at, updated_at
         FROM master_users
         WHERE id = ?
         LIMIT 1`,
        [payload.id]
    );

    if (patients.length === 0) {
        throw new AppError('Patient not found', 404);
    }

    const patient = patients[0];

    if (!patient.is_active) {
        throw new AppError('Patient account is inactive', 403);
    }

    await query(
        `UPDATE tbl_user_refresh_tokens
         SET revoked_at = COALESCE(revoked_at, NOW())
         WHERE id = ?`,
        [storedRefreshToken.id]
    );

    const language = await getDefaultLanguage();
    const issuedTokens = await issueAuthTokens({ patient, req });

    return res.status(200).json({
        success: true,
        message: 'Token refreshed successfully',
        data: await buildAuthData({
            patient,
            languageId: language ? language.id : null,
            token: issuedTokens.token,
            refreshToken: issuedTokens.refresh_token,
            oldToken: refreshTokenValue,
        }),
    });
});

const logout = asyncHandler(async (req, res) => {
    if (!req.user?.token_jti) {
        throw new AppError('Authenticated access token is missing token identifier', 400);
    }

    const decodedAccess = jwt.decode(req.user.token);
    const expiresAt = decodedAccess?.exp
        ? new Date(Number(decodedAccess.exp) * 1000)
        : null;

    if (!expiresAt || Number.isNaN(expiresAt.getTime())) {
        throw new AppError('Unable to determine token expiry for logout', 400);
    }

    await query(
        `INSERT INTO tbl_user_access_token_blacklist
         (patient_id, token_jti, expires_at)
         VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE
         expires_at = VALUES(expires_at),
         revoked_at = CURRENT_TIMESTAMP`,
        [req.user.id, req.user.token_jti, expiresAt]
    );

    await revokeAllRefreshTokensForPatient(req.user.id);

    return res.status(200).json({
        success: true,
        message: 'Logout successful',
        data: {
            logged_out_user_id: req.user.id,
            note: 'Access token revoked. Login again to access protected routes.',
        },
    });
});

const changePassword = asyncHandler(async (req, res) => {
    const { current_password, new_password } = req.body;

    if (!new_password) {
        throw new AppError('new_password is required', 400);
    }

    if (String(new_password).length < 6) {
        throw new AppError('new_password must be at least 6 characters', 400);
    }

    const userId = req.user.id;

    const userRows = await query(
        `SELECT id, password, is_active
         FROM master_users
         WHERE id = ?
         LIMIT 1`,
        [userId]
    );

    if (userRows.length === 0) {
        throw new AppError('User not found', 404);
    }

    const user = userRows[0];

    if (!user.is_active) {
        throw new AppError('User account is inactive', 403);
    }

    if (user.password) {
        if (!current_password) {
            throw new AppError('current_password is required', 400);
        }
        const isMatch = await bcrypt.compare(String(current_password), user.password);
        if (!isMatch) {
            throw new AppError('Current password is incorrect', 400);
        }
    }

    const hashedPassword = await bcrypt.hash(String(new_password), 10);

    await query(
        `UPDATE master_users
         SET password = ?, updated_by = ?, updated_ip = ?
         WHERE id = ?`,
        [hashedPassword, userId, getClientIp(req), userId]
    );

    return res.status(200).json({
        success: true,
        message: 'Password changed successfully',
    });
});

module.exports = {
    requestRegistrationOtp,
    verifyRegistrationOtp,
    registerUser,
    login,
    requestLoginOtp,
    verifyLoginOtp,
    getCurrentPatient,
    listSelectableBranches,
    selectCurrentBranch,
    updateCurrentPatientProfile,
    requestForgotPasswordOtp,
    verifyForgotPasswordOtp,
    resetForgotPassword,
    changePassword,
    refreshToken,
    logout,
};
