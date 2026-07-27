require('dotenv').config();
const { query, pool } = require('./config/db');
const { getLiveQueueSnapshot } = require('./services/liveQueueService');

async function test() {
    try {
        console.log("Connecting to Database...");
        
        // Find slot & date with active queue appointments
        const rows = await query(`
            SELECT fk_branch_id, fk_slot_id, appointment_date, COUNT(*) as cnt
            FROM tbl_appointments 
            WHERE is_active = 1
              AND LOWER(status) IN ('pending', 'confirmed')
              AND queue_status IN ('BOOKED', 'CHECKED_IN', 'WAITING', 'IN_PROGRESS')
            GROUP BY fk_branch_id, fk_slot_id, appointment_date
            ORDER BY cnt DESC
            LIMIT 1
        `);

        let testRow = rows[0];
        if (!testRow) {
            console.log("No pending/confirmed queue items found. Falling back to latest active appointment...");
            const fallbackRows = await query(`
                SELECT fk_branch_id, fk_slot_id, appointment_date 
                FROM tbl_appointments 
                WHERE is_active = 1
                ORDER BY appointment_date DESC 
                LIMIT 1
            `);
            testRow = fallbackRows[0];
        }

        if (!testRow) {
            console.log("No appointments found in database to test.");
            return;
        }

        const { fk_branch_id: branchId, fk_slot_id: slotId, appointment_date: appointmentDate } = testRow;
        const formattedDate = new Date(appointmentDate).toISOString().split('T')[0];

        console.log(`Found Test Data -> Branch ID: ${branchId}, Slot ID: ${slotId}, Date: ${formattedDate}`);
        console.log("Executing getLiveQueueSnapshot...\n");

        const snapshot = await getLiveQueueSnapshot({
            branchId,
            slotId,
            appointmentDate: formattedDate
        });

        console.log("--- SNAPSHOT RESULT ---");
        console.log(JSON.stringify(snapshot, null, 2));
        console.log("-----------------------\n");

    } catch (err) {
        console.error("Error executing script:", err);
    } finally {
        await pool.end();
        console.log("Database connection closed.");
    }
}

test();
