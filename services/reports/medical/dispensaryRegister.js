const { query } = require('../shared');
const { decorateTokenFields } = require('../../../utils/tokenDisplay');
const { consultationPositionSql } = require('../../../utils/consultationPosition');
const AppError = require('../../../utils/AppError');

const cents = value => Math.round((Number(value) || 0) * 100);
const summarizeDispensary = (pending, bills) => {
    const sum = key => bills.reduce((total, row) => total + cents(row[key]), 0) / 100;
    const days = new Map();
    for (const bill of bills) {
        const date = bill.bill_date;
        if (!days.has(date)) days.set(date, { date, bills: 0, net_cents: 0 });
        const day = days.get(date);
        day.bills += 1;
        day.net_cents += cents(bill.total_amount);
    }
    return {
        summary: { pending_count: pending.length, dispensed_bills: bills.length, net_billed: sum('total_amount'), paid: sum('paid_amount'), pending: sum('pending_amount') },
        trend: [...days.values()].sort((a,b) => a.date.localeCompare(b.date)).map(day => ({ date: day.date, bills: day.bills, net_billed: day.net_cents / 100 })),
    };
};

const getDispensaryRegister = async ({ fromDate, toDate, branchId }) => {
    if (!Number.isInteger(Number(branchId)) || Number(branchId) <= 0) throw new AppError('Please select a branch', 400);
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
    const billScope = "b.bill_type='MEDICATION' AND b.status='ACTIVE' AND b.fk_branch_id=? AND DATE(b.created_at)>=? AND DATE(b.created_at)<=?";
    const billParams = [branchId, fromDate, toDate];
    const [pending, bills, topMedicines] = await Promise.all([
        query(`SELECT c.id AS consultation_id,c.appointment_id,
            a.fk_patient_id,a.fk_patient_family_member_id AS family_member_id,
            p.uuid AS patient_uuid,COALESCE(fm.full_name,p.full_name) AS patient_full_name,
            p.mobile_no AS patient_mobile_no,d.full_name AS doctor_name,t.treatment_name,
            DATE_FORMAT(a.appointment_date,'%Y-%m-%d') AS appointment_date,
            COALESCE(c.sent_to_medical_at,c.created_at) AS sent_at,
            GREATEST(0,DATEDIFF(?,COALESCE(c.sent_to_medical_at,c.created_at))) AS waiting_days,
            a.original_token_number,a.current_token_number AS token_number,
            ${consultationPositionSql} AS queue_position,s.slot_name,s.start_time
            FROM tbl_consultations c JOIN tbl_appointments a ON a.appointment_id=c.appointment_id
            LEFT JOIN master_users p ON p.id=a.fk_patient_id
            LEFT JOIN tbl_patient_family_members fm ON fm.id=a.fk_patient_family_member_id
            LEFT JOIN master_users d ON d.id=c.doctor_id
            LEFT JOIN master_treatments t ON t.id=a.fk_treatment_id
            LEFT JOIN master_slots s ON s.id=a.fk_slot_id
            WHERE a.fk_branch_id=? AND a.is_active=1 AND a.status='Completed'
              AND c.workflow_status='READY_FOR_MEDICAL'
            ORDER BY COALESCE(c.sent_to_medical_at,c.created_at) ASC,c.id ASC`, [today,branchId]),
        query(`SELECT b.id AS bill_id,b.bill_number,b.patient_id AS fk_patient_id,
            b.appointment_id,b.consultation_id,b.created_at AS dispensed_at,
            DATE_FORMAT(b.created_at,'%Y-%m-%d') AS bill_date,
            b.gross_amount,b.discount_amount,b.total_amount,b.paid_amount,b.pending_amount,
            b.payment_status,COALESCE(b.delivery_mode,'HAND_DELIVERY') AS delivery_mode,
            p.uuid AS patient_uuid,COALESCE(fm.full_name,p.full_name) AS patient_full_name,
            p.mobile_no AS patient_mobile_no,a.fk_patient_family_member_id AS family_member_id,
            d.full_name AS doctor_name,t.treatment_name,
            CASE WHEN b.appointment_id IS NOT NULL THEN 'REGULAR'
                 WHEN b.consultation_id IS NULL OR COALESCE(b.remark,'') LIKE '%Medical Only%' THEN 'DIRECT'
                 ELSE 'REPEAT' END AS medicine_type,
            CASE WHEN b.appointment_id IS NOT NULL THEN a.original_token_number END AS original_token_number,
            CASE WHEN b.appointment_id IS NOT NULL THEN a.current_token_number END AS token_number,
            CASE WHEN b.appointment_id IS NOT NULL THEN ${consultationPositionSql} END AS queue_position,
            CASE WHEN b.appointment_id IS NOT NULL THEN s.slot_name END AS slot_name,s.start_time
            FROM tbl_bills b
            LEFT JOIN tbl_consultations c ON c.id=b.consultation_id
            LEFT JOIN tbl_appointments a ON a.appointment_id=COALESCE(b.appointment_id,c.appointment_id)
            LEFT JOIN master_users p ON p.id=b.patient_id
            LEFT JOIN tbl_patient_family_members fm ON fm.id=a.fk_patient_family_member_id
            LEFT JOIN master_users d ON d.id=c.doctor_id
            LEFT JOIN master_treatments t ON t.id=a.fk_treatment_id
            LEFT JOIN master_slots s ON s.id=a.fk_slot_id
            WHERE ${billScope}
            ORDER BY b.created_at DESC,b.id DESC`, billParams),
        query(`SELECT TRIM(bi.item_name) AS medicine_name,COUNT(DISTINCT bi.bill_id) AS bill_count
            FROM tbl_bill_items bi JOIN tbl_bills b ON b.id=bi.bill_id
            WHERE ${billScope}
              AND UPPER(bi.item_type) IN ('MEDICATION','ADDITIONAL_MEDICATION')
              AND LOWER(TRIM(COALESCE(bi.item_name,''))) NOT IN ('','courier charge')
            GROUP BY TRIM(bi.item_name)
            ORDER BY bill_count DESC,medicine_name ASC LIMIT 6`, billParams),
    ]);
    return { as_of: today, pending: pending.map(row => decorateTokenFields(row)), bills: bills.map(row => decorateTokenFields(row)), top_medicines: topMedicines, ...summarizeDispensary(pending,bills) };
};

module.exports = { getDispensaryRegister, summarizeDispensary };
