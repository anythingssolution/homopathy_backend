require('dotenv').config();
const { query } = require('./config/db');

(async () => {
  try {
    console.log('Running layout migration...');
    await query(`CREATE TABLE IF NOT EXISTS \`tbl_branch_token_layouts\` (
      \`id\` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
      \`fk_branch_id\` bigint(20) unsigned NOT NULL,
      \`token_number\` int(11) NOT NULL,
      \`visit_type_code\` varchar(50) NOT NULL,
      \`created_at\` timestamp NOT NULL DEFAULT current_timestamp(),
      \`updated_at\` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
      PRIMARY KEY (\`id\`),
      UNIQUE KEY \`idx_branch_token\` (\`fk_branch_id\`, \`token_number\`),
      CONSTRAINT \`fk_token_layout_branch\` FOREIGN KEY (\`fk_branch_id\`) REFERENCES \`master_clinic_branches\` (\`id\`) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;`);
    console.log('Migration executed successfully!');
  } catch (err) {
    console.error('Migration failed:', err);
  } finally {
    process.exit(0);
  }
})();
