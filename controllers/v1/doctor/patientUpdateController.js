const {
    query,
    withTransaction,
    AppError,
    asyncHandler,
    toPositiveInt,
} = require('./shared');

const PATIENT_ROLE = 'PAT';
const validateGender = (gender) => ['male', 'female', 'other'].includes(String(gender || '').toLowerCase());
const validateMobile = (mobileNo) => /^[0-9]{10,15}$/.test(String(mobileNo || '').trim());

const getClientIp = (req) => {
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) {
        return forwarded.split(',')[0].trim();
    }

    return req.ip || req.socket?.remoteAddress || '0.0.0.0';
};

const updateDoctorPatient = asyncHandler(async (req, res) => {
    const patientId = toPositiveInt(req.params.patient_id);
    const familyMemberId = toPositiveInt(req.body?.family_member_id);
    const branchId = req.selectedBranchId || null;
    const fullName = req.body?.full_name !== undefined ? String(req.body.full_name).trim() : undefined;
    const mobileNo = req.body?.mobile_no !== undefined ? String(req.body.mobile_no).trim() : undefined;
    const gender = req.body?.gender !== undefined ? String(req.body.gender).trim().toLowerCase() : undefined;
    const age = req.body?.age !== undefined ? toPositiveInt(req.body.age) : undefined;

    if (!patientId) {
        throw new AppError('Valid patient_id is required', 400);
    }

    if (fullName === undefined && mobileNo === undefined && gender === undefined && age === undefined) {
        throw new AppError('At least one of full_name, mobile_no, gender or age is required', 400);
    }

    if (fullName !== undefined && (!fullName || fullName.length > 100)) {
        throw new AppError('full_name must be between 1 and 100 characters', 400);
    }

    if (mobileNo !== undefined && !validateMobile(mobileNo)) {
        throw new AppError('mobile_no must be 10 to 15 digits', 400);
    }

    if (gender !== undefined && !validateGender(gender)) {
        throw new AppError("gender must be one of 'male', 'female' or 'other'", 400);
    }

    if (age !== undefined && (age === null || age < 1 || age > 120)) {
        throw new AppError('age must be between 1 and 120', 400);
    }

    const actorIp = getClientIp(req);
    const actorRole = req.user?.role_code || req.user?.role || 'doctor';
    const actorUserAgent = req.headers['user-agent'] || null;

    const result = await withTransaction(async (connection) => {
        const [patientRows] = await connection.execute(
            `SELECT id, uuid, full_name, mobile_no, gender, age, role, is_active, updated_at
             FROM master_users
             WHERE id = ?
             LIMIT 1
             FOR UPDATE`,
            [patientId]
        );

        if (patientRows.length === 0) {
            throw new AppError('Patient not found', 404);
        }

        const patient = patientRows[0];

        if (String(patient.role || '').toUpperCase() !== PATIENT_ROLE) {
            throw new AppError('Selected record is not a patient account', 409);
        }

        if (Number(patient.is_active) !== 1) {
            throw new AppError('Selected patient is inactive', 409);
        }

        if (branchId) {
            const [branchRows] = await connection.execute(
                `SELECT appointment_id
                 FROM tbl_appointments
                 WHERE fk_patient_id = ?
                   AND fk_branch_id = ?
                 LIMIT 1`,
                [patientId, branchId]
            );

            if (branchRows.length === 0) {
                throw new AppError('Patient is not available in the selected branch', 403);
            }
        }

        if (familyMemberId) {
            const [fmRows] = await connection.execute(
                `SELECT id, full_name, age, gender, description, is_active
                 FROM tbl_patient_family_members
                 WHERE id = ?
                   AND patient_id = ?
                 LIMIT 1
                 FOR UPDATE`,
                [familyMemberId, patientId]
            );

            if (fmRows.length === 0) {
                throw new AppError('Family member not found', 404);
            }

            const fm = fmRows[0];
            const fmChangedFields = [];
            const fmOldValues = {};
            const fmNewValues = {};
            const fmRequestedValues = { full_name: fullName, gender, age };

            for (const [field, value] of Object.entries(fmRequestedValues)) {
                if (value !== undefined && String(value) !== String(fm[field] ?? '')) {
                    fmChangedFields.push(field);
                    fmOldValues[field] = fm[field];
                    fmNewValues[field] = value;
                }
            }

            if (mobileNo !== undefined && mobileNo !== patient.mobile_no) {
                const [duplicateRows] = await connection.execute(
                    `SELECT id FROM master_users WHERE mobile_no = ? AND id <> ? LIMIT 1`,
                    [mobileNo, patientId]
                );
                if (duplicateRows.length > 0) {
                    throw new AppError('Mobile number already in use by another user', 409);
                }

                await connection.execute(
                    `UPDATE master_users SET mobile_no = ?, updated_by = ?, updated_ip = ? WHERE id = ?`,
                    [mobileNo, req.user.id, actorIp, patientId]
                );
                fmChangedFields.push('mobile_no');
                fmOldValues.mobile_no = patient.mobile_no;
                fmNewValues.mobile_no = mobileNo;
            }

            if (fmChangedFields.length === 0) {
                throw new AppError('No patient details were changed', 400);
            }

            const fmUpdateParts = [];
            const fmUpdateValues = [];
            for (const field of ['full_name', 'gender', 'age']) {
                if (fmNewValues[field] !== undefined) {
                    fmUpdateParts.push(`${field} = ?`);
                    fmUpdateValues.push(fmNewValues[field]);
                }
            }

            if (fmUpdateParts.length > 0) {
                fmUpdateValues.push(familyMemberId);
                await connection.execute(
                    `UPDATE tbl_patient_family_members SET ${fmUpdateParts.join(', ')} WHERE id = ?`,
                    fmUpdateValues
                );
            }

            await connection.execute(
                `INSERT INTO log_user_profile_updates
                 (user_id, changed_by_user_id, changed_by_role, ip_address, user_agent, changed_fields_json, old_values_json, new_values_json)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    patientId,
                    req.user.id,
                    actorRole,
                    actorIp,
                    actorUserAgent,
                    JSON.stringify(fmChangedFields.map((f) => `family_member.${f}`)),
                    JSON.stringify(fmOldValues),
                    JSON.stringify(fmNewValues),
                ]
            );

            return {
                patient: {
                    patient_id: patientId,
                    patient_uuid: patient.uuid,
                    full_name: fmNewValues.full_name ?? fm.full_name,
                    age: fmNewValues.age ?? fm.age,
                    gender: fmNewValues.gender ?? fm.gender,
                    mobile_no: mobileNo ?? patient.mobile_no,
                },
                changed_fields: fmChangedFields,
                entity_type: 'FAMILY_MEMBER',
            };
        }

        if (mobileNo !== undefined && mobileNo !== patient.mobile_no) {
            const [duplicateRows] = await connection.execute(
                `SELECT id
                 FROM master_users
                 WHERE mobile_no = ?
                   AND id <> ?
                 LIMIT 1`,
                [mobileNo, patientId]
            );

            if (duplicateRows.length > 0) {
                throw new AppError('Mobile number already in use by another user', 409);
            }
        }

        const oldValues = {};
        const newValues = {};
        const changedFields = [];
        const requestedValues = {
            full_name: fullName,
            mobile_no: mobileNo,
            gender,
            age,
        };

        for (const [field, value] of Object.entries(requestedValues)) {
            if (value !== undefined && String(value) !== String(patient[field] ?? '')) {
                changedFields.push(field);
                oldValues[field] = patient[field];
                newValues[field] = value;
            }
        }

        if (changedFields.length === 0) {
            throw new AppError('No patient details were changed', 400);
        }

        const updateParts = changedFields.map((field) => `${field} = ?`);
        const updateValues = changedFields.map((field) => newValues[field]);
        updateParts.push('updated_by = ?', 'updated_ip = ?');
        updateValues.push(req.user.id, actorIp, patientId);

        await connection.execute(
            `UPDATE master_users
             SET ${updateParts.join(', ')}
             WHERE id = ?`,
            updateValues
        );

        await connection.execute(
            `INSERT INTO log_user_profile_updates
             (user_id, changed_by_user_id, changed_by_role, ip_address, user_agent, changed_fields_json, old_values_json, new_values_json)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                patientId,
                req.user.id,
                actorRole,
                actorIp,
                actorUserAgent,
                JSON.stringify(changedFields),
                JSON.stringify(oldValues),
                JSON.stringify(newValues),
            ]
        );

        const [updatedRows] = await connection.execute(
            `SELECT id AS patient_id, uuid AS patient_uuid, full_name, age, gender, email, mobile_no,
                    description, created_at, updated_at
             FROM master_users
             WHERE id = ?
             LIMIT 1`,
            [patientId]
        );

        return {
            patient: updatedRows[0],
            changed_fields: changedFields,
            entity_type: 'SELF',
        };
    });

    return res.status(200).json({
        success: true,
        message: 'Patient details updated successfully',
        data: result,
    });
});

module.exports = {
    updateDoctorPatient,
};
