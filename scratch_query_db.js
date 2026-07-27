require('dotenv').config();
const { query, pool } = require('./config/db');

async function run() {
    try {
        console.log("--- Find active sessions ---");
        const sessions = await query(`
            SELECT * FROM tbl_live_queue_sessions
            ORDER BY appointment_date DESC
            LIMIT 5
        `);
        console.log(JSON.stringify(sessions, null, 2));

        console.log("--- Find active appointments for 2026-06-04 ---");
        const appts = await query(`
            SELECT appointment_id, fk_branch_id, fk_slot_id, current_token_number, queue_status, checked_in_at, planned_start_at, actual_called_at, actual_started_at, actual_completed_at
            FROM tbl_appointments
            WHERE appointment_date = '2026-06-04'
            ORDER BY current_token_number ASC
        `);
        console.log(JSON.stringify(appts, null, 2));

    } catch (err) {
        console.error(err);
    } finally {
        await pool.end();
    }
}

run();

