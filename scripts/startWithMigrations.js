require('dotenv').config();

const { runFromEnvironment } = require('./migrationRunner');

const start = async () => {
    const result = await runFromEnvironment();
    console.log(
        `[startup] Database ready: ${result.applied} migration(s) applied, ` +
        `${result.skipped} already applied`
    );

    require('../server');
};

start().catch((error) => {
    console.error(`[startup] Database migration failed: ${error.message}`);
    process.exit(1);
});
