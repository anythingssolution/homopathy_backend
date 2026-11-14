const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { env } = require('../config/env');
const AppError = require('../utils/AppError');

const normalizeMemberName = value => String(value || '').normalize('NFKC').toLocaleLowerCase('en-IN')
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

const isPossibleFamilyMatch = (existing, proposed) => {
    const name = normalizeMemberName(proposed.full_name);
    const previous = normalizeMemberName(existing.full_name);
    if (!name || !previous) return false;
    if (name === previous) return true;
    const shorter = name.length < previous.length ? name : previous;
    const longer = name.length < previous.length ? previous : name;
    // This asks for a review, not an identity merge. Demographic entry errors
    // must not suppress the warning for a shortened version of the same name.
    return shorter.split(' ').every(word => longer.split(' ').includes(word))
        && shorter.split(' ')[0] === longer.split(' ')[0];
};

// The account lock serializes patient and reception creation paths, including retries.
// Confirmation is bound to this form and the current matching records. A replay after
// an insert sees a different fingerprint and must be reviewed again.
const guardFamilyMemberCreation = async (connection, { patientId, payload, confirmationToken }) => {
    const [accounts] = await connection.execute('SELECT id FROM master_users WHERE id = ? FOR UPDATE', [patientId]);
    if (!accounts.length) throw new AppError('Patient not found', 404);
    const [members] = await connection.execute(
        `SELECT id AS family_member_id, full_name, age, DATE_FORMAT(date_of_birth, '%Y-%m-%d') AS date_of_birth, gender, relationship, is_active
         FROM tbl_patient_family_members WHERE fk_primary_patient_id = ? ORDER BY id FOR UPDATE`, [patientId]);
    const candidates = members.filter(member => isPossibleFamilyMatch(member, payload));
    if (!candidates.length) return;
    const payloadHash = hash(payload);
    const fingerprint = hash(candidates);
    if (confirmationToken) {
        try {
            const decoded = jwt.verify(confirmationToken, env.jwtSecret, { algorithms: ['HS256'] });
            if (decoded.purpose === 'distinct-family-member' && decoded.patientId === Number(patientId)
                && decoded.payloadHash === payloadHash && decoded.fingerprint === fingerprint) return;
        } catch { /* Expired, stale or tampered confirmation: present the current matches. */ }
    }
    for (const member of candidates) {
        const [visits] = await connection.execute(
            `SELECT DATE_FORMAT(a.appointment_date, '%Y-%m-%d') AS appointment_date, b.branch_name
             FROM tbl_appointments a JOIN master_clinic_branches b ON b.id = a.fk_branch_id
             WHERE a.fk_patient_id = ? AND a.fk_patient_family_member_id = ? AND a.is_active = 1 AND a.status = 'Completed'
             ORDER BY a.appointment_date DESC, a.appointment_id DESC LIMIT 1`, [patientId, member.family_member_id]);
        member.last_visit = visits[0] || null;
    }
    throw new AppError('A similar family member already exists. Select the existing member or confirm this is a different person.', 409, {
        code: 'FAMILY_MEMBER_MATCH', candidates,
        confirmation_token: jwt.sign({ purpose: 'distinct-family-member', patientId: Number(patientId), payloadHash, fingerprint }, env.jwtSecret,
            { algorithm: 'HS256', expiresIn: '10m' }),
    });
};

module.exports = { normalizeMemberName, isPossibleFamilyMatch, guardFamilyMemberCreation };
