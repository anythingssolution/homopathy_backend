const { query, withTransaction } = require('../../config/db');
const AppError = require('../../utils/AppError');
const asyncHandler = require('../../utils/asyncHandler');
const { MAX_ACTIVE_FAMILY_MEMBERS } = require('../../utils/patientFamily');

const toPositiveInt = (value) => {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) {
        return null;
    }

    return parsed;
};

const validateGender = (gender) => ['male', 'female', 'other'].includes(String(gender || '').toLowerCase());

const normalizeFamilyMemberPayload = (body = {}, { partial = false } = {}) => {
    const fullName = body.full_name !== undefined ? String(body.full_name || '').trim() : undefined;
    const relationship = body.relationship !== undefined ? String(body.relationship || '').trim() : undefined;
    const description = body.description !== undefined ? String(body.description || '').trim() : undefined;
    const age = body.age !== undefined && body.age !== null && body.age !== '' ? toPositiveInt(body.age) : undefined;
    const gender = body.gender !== undefined ? String(body.gender || '').trim().toLowerCase() : undefined;

    if (!partial || body.full_name !== undefined) {
        if (!fullName) {
            throw new AppError('full_name is required', 400);
        }
    }

    if (!partial || body.relationship !== undefined) {
        if (!relationship) {
            throw new AppError('relationship is required', 400);
        }
    }

    if (!partial || body.age !== undefined) {
        if (!age) {
            throw new AppError('age must be a positive integer', 400);
        }
    }

    if (!partial || body.gender !== undefined) {
        if (!validateGender(gender)) {
            throw new AppError("gender must be one of 'male', 'female' or 'other'", 400);
        }
    }

    return {
        full_name: fullName,
        relationship,
        age,
        gender,
        description: description || null,
    };
};

const listFamilyMembers = asyncHandler(async (req, res) => {
    const includeInactive = String(req.query.include_inactive || '').trim() === '1';
    const params = [req.user.id];
    let whereClause = 'WHERE fm.fk_primary_patient_id = ?';

    if (!includeInactive) {
        whereClause += ' AND fm.is_active = 1';
    }

    const rows = await query(
        `SELECT
            fm.id AS family_member_id,
            fm.fk_primary_patient_id,
            fm.full_name,
            fm.age,
            fm.gender,
            fm.relationship,
            fm.description,
            fm.is_active,
            fm.created_at,
            fm.updated_at
         FROM tbl_patient_family_members fm
         ${whereClause}
         ORDER BY fm.is_active DESC, fm.created_at ASC, fm.id ASC`,
        params
    );

    const activeCount = rows.filter((row) => Number(row.is_active) === 1).length;

    return res.status(200).json({
        success: true,
        message: 'Family members fetched successfully',
        data: rows,
        meta: {
            total: rows.length,
            active_total: activeCount,
            max_active_family_members: MAX_ACTIVE_FAMILY_MEMBERS,
        },
    });
});

const createFamilyMember = asyncHandler(async (req, res) => {
    const payload = normalizeFamilyMemberPayload(req.body);

    const familyMemberId = await withTransaction(async (connection) => {
        const [activeRows] = await connection.execute(
            `SELECT COUNT(*) AS active_count
             FROM tbl_patient_family_members
             WHERE fk_primary_patient_id = ?
               AND is_active = 1
             FOR UPDATE`,
            [req.user.id]
        );

        if (Number(activeRows[0]?.active_count || 0) >= MAX_ACTIVE_FAMILY_MEMBERS) {
            throw new AppError(`Maximum ${MAX_ACTIVE_FAMILY_MEMBERS} active family members are allowed per patient account`, 409);
        }

        const [insertResult] = await connection.execute(
            `INSERT INTO tbl_patient_family_members
             (fk_primary_patient_id, full_name, age, gender, relationship, description, is_active, created_by, updated_by, created_ip, updated_ip)
             VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
            [
                req.user.id,
                payload.full_name,
                payload.age,
                payload.gender,
                payload.relationship,
                payload.description,
                req.user.id,
                req.user.id,
                req.ip || req.socket?.remoteAddress || '0.0.0.0',
                req.ip || req.socket?.remoteAddress || '0.0.0.0',
            ]
        );

        return insertResult.insertId;
    });

    const rows = await query(
        `SELECT
            fm.id AS family_member_id,
            fm.fk_primary_patient_id,
            fm.full_name,
            fm.age,
            fm.gender,
            fm.relationship,
            fm.description,
            fm.is_active,
            fm.created_at,
            fm.updated_at
         FROM tbl_patient_family_members fm
         WHERE fm.id = ?
         LIMIT 1`,
        [familyMemberId]
    );

    return res.status(201).json({
        success: true,
        message: 'Family member created successfully',
        data: rows[0] || null,
    });
});

const updateFamilyMember = asyncHandler(async (req, res) => {
    const familyMemberId = toPositiveInt(req.params.family_member_id);
    if (!familyMemberId) {
        throw new AppError('Valid family_member_id is required', 400);
    }

    const payload = normalizeFamilyMemberPayload(req.body, { partial: true });
    const requestedIsActive = req.body?.is_active;
    const hasIsActivePatch = requestedIsActive !== undefined;
    const nextIsActive = hasIsActivePatch ? (Number(requestedIsActive) === 1 ? 1 : 0) : undefined;

    if (Object.values(payload).every((value) => value === undefined) && !hasIsActivePatch) {
        throw new AppError('At least one field must be provided to update family member', 400);
    }

    await withTransaction(async (connection) => {
        const [memberRows] = await connection.execute(
            `SELECT id, is_active
             FROM tbl_patient_family_members
             WHERE id = ?
               AND fk_primary_patient_id = ?
             LIMIT 1
             FOR UPDATE`,
            [familyMemberId, req.user.id]
        );

        if (memberRows.length === 0) {
            throw new AppError('Family member not found', 404);
        }

        if (hasIsActivePatch && nextIsActive === 1 && Number(memberRows[0].is_active) !== 1) {
            const [activeRows] = await connection.execute(
                `SELECT COUNT(*) AS active_count
                 FROM tbl_patient_family_members
                 WHERE fk_primary_patient_id = ?
                   AND is_active = 1
                 FOR UPDATE`,
                [req.user.id]
            );

            if (Number(activeRows[0]?.active_count || 0) >= MAX_ACTIVE_FAMILY_MEMBERS) {
                throw new AppError(`Maximum ${MAX_ACTIVE_FAMILY_MEMBERS} active family members are allowed per patient account`, 409);
            }
        }

        const fields = [];
        const params = [];

        Object.entries(payload).forEach(([key, value]) => {
            if (value !== undefined) {
                fields.push(`${key} = ?`);
                params.push(value);
            }
        });

        if (hasIsActivePatch) {
            fields.push('is_active = ?');
            params.push(nextIsActive);
        }

        fields.push('updated_by = ?');
        params.push(req.user.id);
        fields.push('updated_ip = ?');
        params.push(req.ip || req.socket?.remoteAddress || '0.0.0.0');

        await connection.execute(
            `UPDATE tbl_patient_family_members
             SET ${fields.join(', ')}
             WHERE id = ?
               AND fk_primary_patient_id = ?`,
            [...params, familyMemberId, req.user.id]
        );
    });

    const rows = await query(
        `SELECT
            fm.id AS family_member_id,
            fm.fk_primary_patient_id,
            fm.full_name,
            fm.age,
            fm.gender,
            fm.relationship,
            fm.description,
            fm.is_active,
            fm.created_at,
            fm.updated_at
         FROM tbl_patient_family_members fm
         WHERE fm.id = ?
           AND fm.fk_primary_patient_id = ?
         LIMIT 1`,
        [familyMemberId, req.user.id]
    );

    return res.status(200).json({
        success: true,
        message: 'Family member updated successfully',
        data: rows[0] || null,
    });
});

module.exports = {
    listFamilyMembers,
    createFamilyMember,
    updateFamilyMember,
};
