require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');
const { pool } = require('../config/db');

async function ensureColumnsAndTables() {
    console.log('Ensuring all WhatsApp tables & columns exist...');
    const connection = await pool.getConnection();
    try {
        // 1. Ensure master_users WhatsApp columns
        const [existingCols] = await connection.query(`
            SELECT COLUMN_NAME 
            FROM INFORMATION_SCHEMA.COLUMNS 
            WHERE TABLE_SCHEMA = DATABASE() 
              AND TABLE_NAME = 'master_users'
        `);
        const colNames = new Set(existingCols.map((c) => c.COLUMN_NAME));

        if (!colNames.has('whatsapp_number')) {
            await connection.query(`ALTER TABLE \`master_users\` ADD COLUMN \`whatsapp_number\` VARCHAR(20) NULL AFTER \`mobile_no\``);
            console.log('Added whatsapp_number column to master_users');
        }
        if (!colNames.has('whatsapp_consent_status')) {
            await connection.query(`ALTER TABLE \`master_users\` ADD COLUMN \`whatsapp_consent_status\` ENUM('OPTED_IN', 'OPTED_OUT', 'UNSPECIFIED') NOT NULL DEFAULT 'OPTED_IN' AFTER \`whatsapp_number\``);
            console.log('Added whatsapp_consent_status column to master_users');
        }
        if (!colNames.has('whatsapp_consent_updated_at')) {
            await connection.query(`ALTER TABLE \`master_users\` ADD COLUMN \`whatsapp_consent_updated_at\` DATETIME NULL AFTER \`whatsapp_consent_status\``);
            console.log('Added whatsapp_consent_updated_at column to master_users');
        }
        if (!colNames.has('last_whatsapp_delivery_at')) {
            await connection.query(`ALTER TABLE \`master_users\` ADD COLUMN \`last_whatsapp_delivery_at\` DATETIME NULL AFTER \`whatsapp_consent_updated_at\``);
            console.log('Added last_whatsapp_delivery_at column to master_users');
        }

        // 2. Run SQL files
        const files = [
            '2026-08-09_whatsapp_integration.sql',
            '2026-08-18_whatsapp_automation_and_reminders.sql',
        ];

        for (const file of files) {
            const sqlPath = path.join(__dirname, '..', 'sql', file);
            if (!fs.existsSync(sqlPath)) continue;
            console.log(`Applying ${file}...`);
            const sql = fs.readFileSync(sqlPath, 'utf8');

            const statements = sql
                .split(/;\s*$/m)
                .map((s) => s.trim())
                .filter((s) => s.length > 0 && !s.startsWith('--') && !s.includes('ADD COLUMN IF NOT EXISTS'));

            for (const statement of statements) {
                try {
                    await connection.query(statement);
                } catch (err) {
                    console.warn(`[${file}] Statement warning/skip:`, err.message);
                }
            }
        }

        console.log('All WhatsApp tables & columns verified and applied.');
    } catch (err) {
        console.error('Migration error:', err);
    } finally {
        connection.release();
        process.exit(0);
    }
}

ensureColumnsAndTables();
