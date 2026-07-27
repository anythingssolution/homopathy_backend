require('dotenv').config();

const { query, pool } = require('../config/db');

const OLD_TABLE_RENAMES = [
    ['master_products', 'old_master_products'],
    ['master_products_radient_pharma', 'old_master_products_radient_pharma'],
    ['master_handwritten_product_prices', 'old_master_handwritten_product_prices'],
];

const getTableNames = async () => {
    const rows = await query('SHOW TABLES');
    return rows.map((row) => Object.values(row)[0]);
};

const tableExists = async (tableName) => (await getTableNames()).includes(tableName);

const countRows = async (tableName) => {
    const rows = await query(`SELECT COUNT(*) AS total FROM \`${tableName}\``);
    return Number(rows[0]?.total || 0);
};

const logCounts = async (label) => {
    const tables = await getTableNames();
    const payload = {};

    for (const tableName of [
        'master_products',
        'master_products_radient_pharma',
        'master_handwritten_product_prices',
        'master_medical_products',
        'old_master_products',
        'old_master_products_radient_pharma',
        'old_master_handwritten_product_prices',
    ]) {
        payload[tableName] = tables.includes(tableName) ? await countRows(tableName) : null;
    }

    console.log(`${label}: ${JSON.stringify(payload)}`);
};

const createSingleProductMaster = async () => {
    await query(`
        CREATE TABLE IF NOT EXISTS \`master_medical_products\` (
          \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
          \`medicine_text_id\` BIGINT UNSIGNED DEFAULT NULL,
          \`source_type\` ENUM('REGULAR_PRODUCT', 'RADIENT_PHARMA', 'MEDICAL_PRODUCT_PRICE') NOT NULL,
          \`source_old_id\` BIGINT UNSIGNED DEFAULT NULL,
          \`product_name\` VARCHAR(255) NOT NULL,
          \`product_type\` VARCHAR(100) DEFAULT NULL,
          \`category\` VARCHAR(120) DEFAULT NULL,
          \`packing\` VARCHAR(100) DEFAULT NULL,
          \`size_or_weight\` VARCHAR(100) DEFAULT NULL,
          \`mrp_rate\` DECIMAL(10,2) DEFAULT NULL,
          \`price_min\` DECIMAL(10,2) DEFAULT NULL,
          \`price_max\` DECIMAL(10,2) DEFAULT NULL,
          \`shipper_size_pcs\` INT DEFAULT NULL,
          \`description\` TEXT DEFAULT NULL,
          \`formula_composition\` TEXT DEFAULT NULL,
          \`normalized_category\` VARCHAR(120) DEFAULT NULL,
          \`normalized_product_name\` VARCHAR(255) NOT NULL,
          \`dedupe_key\` VARCHAR(700) NOT NULL,
          \`is_active\` TINYINT(1) NOT NULL DEFAULT 1,
          \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          \`updated_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          PRIMARY KEY (\`id\`),
          UNIQUE KEY \`uq_master_medical_products_source_dedupe\` (\`source_type\`, \`dedupe_key\`),
          KEY \`idx_master_medical_products_medicine_text\` (\`medicine_text_id\`),
          KEY \`idx_master_medical_products_source\` (\`source_type\`),
          KEY \`idx_master_medical_products_normalized_name\` (\`normalized_product_name\`),
          CONSTRAINT \`fk_master_medical_products_medicine_text\`
            FOREIGN KEY (\`medicine_text_id\`) REFERENCES \`master_text_medicines\` (\`id\`)
            ON DELETE SET NULL ON UPDATE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);
};

const copyRegularProducts = async () => {
    if (!await tableExists('master_products')) {
        return;
    }

    await query(`
        INSERT IGNORE INTO \`master_medical_products\`
          (\`medicine_text_id\`, \`source_type\`, \`source_old_id\`, \`product_name\`, \`product_type\`,
           \`packing\`, \`mrp_rate\`, \`normalized_product_name\`, \`dedupe_key\`, \`is_active\`,
           \`created_at\`, \`updated_at\`)
        SELECT
          \`medicine_text_id\`,
          'REGULAR_PRODUCT',
          \`id\`,
          \`product_name\`,
          \`product_type\`,
          \`packing\`,
          \`mrp_rate\`,
          \`normalized_product_name\`,
          CONCAT_WS('|', \`normalized_product_name\`, COALESCE(\`packing\`, ''), COALESCE(\`product_type\`, '')),
          \`is_active\`,
          \`created_at\`,
          \`updated_at\`
        FROM \`master_products\`
    `);
};

const copyRadientPharmaProducts = async () => {
    if (!await tableExists('master_products_radient_pharma')) {
        return;
    }

    await query(`
        INSERT IGNORE INTO \`master_medical_products\`
          (\`medicine_text_id\`, \`source_type\`, \`source_old_id\`, \`product_name\`, \`category\`,
           \`size_or_weight\`, \`mrp_rate\`, \`shipper_size_pcs\`, \`description\`,
           \`formula_composition\`, \`normalized_product_name\`, \`dedupe_key\`, \`is_active\`,
           \`created_at\`, \`updated_at\`)
        SELECT
          \`medicine_text_id\`,
          'RADIENT_PHARMA',
          \`id\`,
          \`product_name\`,
          \`category\`,
          \`net_weight_or_size\`,
          \`mrp_rate\`,
          \`shipper_size_pcs\`,
          \`description\`,
          \`formula_composition\`,
          \`normalized_product_name\`,
          CONCAT_WS('|', \`normalized_product_name\`, COALESCE(\`net_weight_or_size\`, ''), COALESCE(\`category\`, '')),
          \`is_active\`,
          \`created_at\`,
          \`updated_at\`
        FROM \`master_products_radient_pharma\`
    `);
};

const copyMedicalProductPrices = async () => {
    if (!await tableExists('master_handwritten_product_prices')) {
        return;
    }

    await query(`
        INSERT IGNORE INTO \`master_medical_products\`
          (\`medicine_text_id\`, \`source_type\`, \`source_old_id\`, \`product_name\`, \`category\`,
           \`price_min\`, \`price_max\`, \`normalized_category\`,
           \`normalized_product_name\`, \`dedupe_key\`, \`is_active\`, \`created_at\`, \`updated_at\`)
        SELECT
          \`medicine_text_id\`,
          'MEDICAL_PRODUCT_PRICE',
          \`id\`,
          \`product_name\`,
          \`category\`,
          \`price_min\`,
          \`price_max\`,
          \`normalized_category\`,
          \`normalized_product_name\`,
          CONCAT_WS('|', COALESCE(\`normalized_category\`, ''), \`normalized_product_name\`),
          \`is_active\`,
          \`created_at\`,
          \`updated_at\`
        FROM \`master_handwritten_product_prices\`
    `);
};

const renameOldTables = async () => {
    const tables = await getTableNames();

    for (const [oldName, newName] of OLD_TABLE_RENAMES) {
        if (!tables.includes(oldName) || tables.includes(newName)) {
            continue;
        }

        await query(`RENAME TABLE \`${oldName}\` TO \`${newName}\``);
        console.log(`renamed ${oldName} -> ${newName}`);
    }
};

const run = async () => {
    try {
        await logCounts('before');
        await createSingleProductMaster();
        await copyRegularProducts();
        await copyRadientPharmaProducts();
        await copyMedicalProductPrices();
        await renameOldTables();

        const bySource = await query(`
            SELECT source_type, COUNT(*) AS total
            FROM master_medical_products
            GROUP BY source_type
            ORDER BY source_type
        `);

        await logCounts('after');
        console.log(`by_source: ${JSON.stringify(bySource)}`);
    } finally {
        await pool.end();
    }
};

run().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
