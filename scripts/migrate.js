require('dotenv').config();

const { runFromEnvironment } = require('./migrationRunner');

const statusOnly = process.argv.includes('--status');

runFromEnvironment({ statusOnly })
    .then((result) => {
        if (statusOnly) {
            console.table(result);
            return;
        }

        console.log(
            `[migrations] Complete: ${result.applied} applied, ` +
            `${result.skipped} already applied, ${result.total} managed`
        );
    })
    .catch((error) => {
        console.error(`[migrations] ${error.message}`);
        process.exitCode = 1;
    });
