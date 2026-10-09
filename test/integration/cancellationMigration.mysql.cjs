// Explicit integration check; creates synthetic rows in an isolated scratch table.
require('dotenv').config();
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const mysql = require('mysql2/promise');

async function main() {
    const table = `migration_check_${crypto.randomBytes(8).toString('hex')}`;
    const connection = await mysql.createConnection({
        host: process.env.DB_HOST,
        port: process.env.DB_PORT || 3306,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
        multipleStatements: true,
        connectTimeout: 10000,
    });
    try {
        const [version] = await connection.query('SELECT VERSION() AS version');
        console.log(`Database engine: ${version[0].version}`);
        await connection.query(`CREATE TABLE \`${table}\` (
            id INT PRIMARY KEY AUTO_INCREMENT,
            fk_branch_id INT NOT NULL, fk_slot_id INT NOT NULL,
            appointment_date DATE NOT NULL, token_number INT NOT NULL,
            is_active TINYINT NOT NULL DEFAULT 1,
            status VARCHAR(32) NOT NULL DEFAULT 'Booked',
            reception_status VARCHAR(40), queue_status VARCHAR(32),
            booking_subject_key VARCHAR(40),
            active_booking_subject_date_key VARCHAR(80)
              GENERATED ALWAYS AS (CONCAT(booking_subject_key, ':', appointment_date)) STORED,
            UNIQUE KEY uq_appointment_branch_slot_date_token_active
              (fk_branch_id, fk_slot_id, appointment_date, token_number, is_active),
            UNIQUE KEY uq_appointment_active_subject_date (active_booking_subject_date_key)
        ) ENGINE=InnoDB`);
        const file = path.resolve(__dirname, '../../sql/migrations/2026-10-09_002_active_appointment_cancellation_keys.sql');
        const sql = (await fs.readFile(file, 'utf8')).replaceAll('tbl_appointments', table);
        await connection.query(sql);
        const [columns] = await connection.query(`SHOW COLUMNS FROM \`${table}\``);
        assert(columns.some(c => c.Field === 'active_token_booking_key'));
        assert(!columns.some(c => c.Field === 'active_booking_subject_date_key'));
        const [indexes] = await connection.query(`SHOW INDEX FROM \`${table}\``);
        assert(indexes.some(i => i.Key_name === 'uq_appointment_active_token_booking' && i.Non_unique === 0));
        assert(!indexes.some(i => i.Key_name === 'uq_appointment_branch_slot_date_token_active'));
        assert(!indexes.some(i => i.Key_name === 'uq_appointment_active_subject_date'));
        await connection.query(sql);
        const insert = `INSERT INTO \`${table}\`
            (fk_branch_id, fk_slot_id, appointment_date, token_number, booking_subject_key)
            VALUES (1, 1, '2026-10-10', 1, 'PAT:synthetic')`;
        await connection.query(insert);
        await assert.rejects(connection.query(insert), { code: 'ER_DUP_ENTRY' });
        await connection.query(`UPDATE \`${table}\` SET status='Cancelled' WHERE id=1`);
        const [second] = await connection.query(insert);
        await connection.query(`UPDATE \`${table}\` SET queue_status='CANCELLED' WHERE id=?`, [second.insertId]);
        const [third] = await connection.query(insert);
        await connection.query(`UPDATE \`${table}\` SET reception_status='REJECTED_BY_RECEPTION' WHERE id=?`, [third.insertId]);
        await connection.query(insert);
        await assert.rejects(connection.query(insert), { code: 'ER_DUP_ENTRY' });
        const [before] = await connection.query(`SELECT * FROM \`${table}\` ORDER BY id`);
        await connection.query(sql);
        const [after] = await connection.query(`SELECT * FROM \`${table}\` ORDER BY id`);
        assert.deepEqual(after, before);
        console.log('PASS: first apply, retry, cancellation/rebooking, rejection, duplicate protection and row preservation');
    } finally {
        try {
            await connection.query(`DROP TABLE IF EXISTS \`${table}\``);
        } finally {
            await connection.end();
        }
    }
}
main().catch(error => {
    console.error(error.code || error.name, error.message);
    process.exitCode = 1;
});
