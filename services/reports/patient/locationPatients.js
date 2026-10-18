const { query } = require('../shared');
const AppError = require('../../../utils/AppError');

const aggregateSubjects = (rows) => {
    const subjects = new Map();
    for (const row of rows) {
        const key = row.family_member_id ? `FM:${row.family_member_id}` : `PAT:${row.patient_id}`;
        if (!subjects.has(key)) subjects.set(key, { ...row, subject_key: key, address_inherited: Boolean(row.family_member_id), consultations: 0, last_consultation: null });
        const subject = subjects.get(key);
        if (row.consultation_id) {
            subject.consultations += 1;
            const date = String(row.consultation_date || '');
            if (!subject.last_consultation || date > subject.last_consultation) subject.last_consultation = date;
        }
    }
    return [...subjects.values()];
};

const getLocationPatients = async ({ fromDate, toDate, branchId }) => {
    if (!Number.isInteger(Number(branchId)) || Number(branchId) <= 0) throw new AppError('Please select a branch', 400);
    const fields = `p.id AS patient_id, p.uuid AS patient_uuid, p.mobile_no AS patient_mobile_no,
        p.city, p.vidhan_sabha, p.area_name, p.ward_no, p.pincode`;
    const branchMembership = `EXISTS (SELECT 1 FROM tbl_appointments ba WHERE ba.fk_patient_id = p.id AND ba.fk_branch_id = ? AND ba.is_active = 1)
        OR EXISTS (SELECT 1 FROM tbl_bills bb WHERE bb.patient_id = p.id AND bb.fk_branch_id = ?)`;
    const historyAccess = `EXISTS (SELECT 1 FROM tbl_appointments ha
        WHERE ha.fk_patient_id=p.id AND ha.fk_branch_id=? AND ha.is_active=1 AND ha.status='Completed')
        OR EXISTS (SELECT 1 FROM tbl_bills hb WHERE hb.patient_id=p.id AND hb.fk_branch_id=?)`;
    const [consulted, primary, family, allPrimary, allFamily] = await Promise.all([
        query(`SELECT ${fields}, fm.id AS family_member_id, COALESCE(fm.full_name,p.full_name) AS patient_full_name,
                DATE_FORMAT(COALESCE(fm.created_at,p.created_at),'%Y-%m-%d') AS registered_date,
                c.id AS consultation_id, DATE_FORMAT(a.appointment_date,'%Y-%m-%d') AS consultation_date
            FROM tbl_consultations c JOIN tbl_appointments a ON a.appointment_id=c.appointment_id
            JOIN master_users p ON p.id=a.fk_patient_id
            LEFT JOIN tbl_patient_family_members fm ON fm.id=a.fk_patient_family_member_id
            WHERE a.fk_branch_id=? AND a.appointment_date>=? AND a.appointment_date<=?
                AND a.is_active=1 AND a.status='Completed'
            ORDER BY a.appointment_date DESC,c.id DESC`, [branchId, fromDate, toDate]),
        query(`SELECT ${fields}, NULL AS family_member_id, p.full_name AS patient_full_name,
                DATE_FORMAT(p.created_at,'%Y-%m-%d') AS registered_date
            FROM master_users p WHERE p.role='PAT' AND p.is_active=1
                AND p.created_at>=? AND p.created_at<DATE_ADD(?, INTERVAL 1 DAY)
                AND (${branchMembership}) ORDER BY p.created_at DESC`, [fromDate, toDate, branchId, branchId]),
        query(`SELECT ${fields}, fm.id AS family_member_id, fm.full_name AS patient_full_name,
                DATE_FORMAT(fm.created_at,'%Y-%m-%d') AS registered_date
            FROM tbl_patient_family_members fm JOIN master_users p ON p.id=fm.fk_primary_patient_id
            WHERE fm.is_active=1 AND p.is_active=1
                AND fm.created_at>=? AND fm.created_at<DATE_ADD(?, INTERVAL 1 DAY)
                AND EXISTS (SELECT 1 FROM tbl_appointments fa WHERE fa.fk_patient_family_member_id=fm.id
                    AND fa.fk_branch_id=? AND fa.is_active=1)
            ORDER BY fm.created_at DESC`, [fromDate, toDate, branchId]),
        query(`SELECT ${fields}, NULL AS family_member_id, p.full_name AS patient_full_name,
                DATE_FORMAT(p.created_at,'%Y-%m-%d') AS registered_date,
                (${historyAccess}) AS can_open_record
            FROM master_users p WHERE p.role='PAT' AND p.is_active=1
            ORDER BY p.full_name,p.id`, [branchId,branchId]),
        query(`SELECT ${fields}, fm.id AS family_member_id, fm.full_name AS patient_full_name,
                DATE_FORMAT(fm.created_at,'%Y-%m-%d') AS registered_date,
                (${historyAccess}) AS can_open_record
            FROM tbl_patient_family_members fm JOIN master_users p ON p.id=fm.fk_primary_patient_id
            WHERE fm.is_active=1 AND p.is_active=1 AND p.role='PAT'
            ORDER BY fm.full_name,fm.id`, [branchId,branchId]),
    ]);
    const consultations = aggregateSubjects(consulted);
    const stats = new Map(consultations.map(row => [row.subject_key, row]));
    const registered = aggregateSubjects([...primary, ...family]).map(row => ({ ...row,
        consultations: stats.get(row.subject_key)?.consultations || 0,
        last_consultation: stats.get(row.subject_key)?.last_consultation || null,
    }));
    return { all: aggregateSubjects([...allPrimary, ...allFamily]), consulted: consultations, registered };
};
module.exports = { getLocationPatients, aggregateSubjects };
