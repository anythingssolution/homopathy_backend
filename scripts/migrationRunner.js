const crypto = require('crypto');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const mysql = require('mysql2/promise');

const MIGRATION_FILENAME_PATTERN = /^(\d{4}-\d{2}-\d{2}_\d{3})_[a-z0-9][a-z0-9_]*\.sql$/;
const TRACKING_TABLE = 'schema_migrations';
const DEFAULT_LOCK_TIMEOUT_SECONDS = 120;
const MAX_ERROR_MESSAGE_LENGTH = 4000;

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

const validateMigrationSql = (name, sql) => {
    if (!sql.trim()) {
        throw new Error(`Migration ${name} is empty`);
    }

    const unsupportedDirective = sql.match(/\b(DELIMITER|SOURCE|USE)\b/i);
    if (unsupportedDirective) {
        throw new Error(
            `Migration ${name} contains unsupported ${unsupportedDirective[1].toUpperCase()} directive`
        );
    }

    if (/\b(CREATE|DROP)\s+DATABASE\b/i.test(sql)) {
        throw new Error(`Migration ${name} must not create or drop a database`);
    }
};

const discoverMigrations = async (migrationsDir) => {
    let entries;

    try {
        entries = await fs.readdir(migrationsDir, { withFileTypes: true });
    } catch (error) {
        if (error.code === 'ENOENT') {
            throw new Error(`Managed migration directory does not exist: ${migrationsDir}`);
        }
        throw error;
    }

    const sqlEntries = entries
        .filter((entry) => entry.isFile() && entry.name.endsWith('.sql'))
        .sort((left, right) => left.name.localeCompare(right.name));

    const seenVersions = new Set();
    const migrations = [];

    for (const entry of sqlEntries) {
        const match = entry.name.match(MIGRATION_FILENAME_PATTERN);
        if (!match) {
            throw new Error(
                `Invalid migration filename ${entry.name}. Expected YYYY-MM-DD_NNN_description.sql`
            );
        }

        const version = match[1];
        if (seenVersions.has(version)) {
            throw new Error(`Duplicate migration version ${version}`);
        }
        seenVersions.add(version);

        const filePath = path.join(migrationsDir, entry.name);
        const contents = await fs.readFile(filePath);
        const sql = contents.toString('utf8');
        validateMigrationSql(entry.name, sql);

        migrations.push({
            name: entry.name,
            version,
            checksum: sha256(contents),
            sql,
        });
    }

    return migrations;
};

const parsePositiveInteger = (value, fallback, name) => {
    if (value === undefined || value === null || value === '') {
        return fallback;
    }

    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new Error(`${name} must be a positive integer`);
    }

    return parsed;
};

const getMigrationConfig = (environment = process.env) => {
    const required = ['DB_HOST', 'DB_USER', 'DB_NAME'];
    const missing = required.filter((key) => !String(environment[key] || '').trim());

    if (missing.length > 0) {
        throw new Error(`Missing database environment variables: ${missing.join(', ')}`);
    }

    return {
        host: String(environment.DB_HOST).trim(),
        port: parsePositiveInteger(environment.DB_PORT, 3306, 'DB_PORT'),
        user: String(environment.DB_USER).trim(),
        password: environment.DB_PASSWORD || '',
        database: String(environment.DB_NAME).trim(),
        connectTimeout: parsePositiveInteger(
            environment.DB_CONNECT_TIMEOUT_MS,
            10000,
            'DB_CONNECT_TIMEOUT_MS'
        ),
        lockTimeoutSeconds: parsePositiveInteger(
            environment.DB_MIGRATION_LOCK_TIMEOUT_SECONDS,
            DEFAULT_LOCK_TIMEOUT_SECONDS,
            'DB_MIGRATION_LOCK_TIMEOUT_SECONDS'
        ),
    };
};

const createMigrationConnection = async (config) => mysql.createConnection({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
    connectTimeout: config.connectTimeout,
    multipleStatements: true,
    timezone: '+05:30',
});

const ensureTrackingTable = async (connection) => {
    await connection.query(`
        CREATE TABLE IF NOT EXISTS \`${TRACKING_TABLE}\` (
            \`migration_name\` varchar(255) NOT NULL,
            \`checksum\` char(64) NOT NULL,
            \`status\` enum('RUNNING','APPLIED','FAILED') NOT NULL,
            \`started_at\` timestamp NULL DEFAULT NULL,
            \`applied_at\` timestamp NULL DEFAULT NULL,
            \`execution_ms\` int unsigned DEFAULT NULL,
            \`applied_by\` varchar(255) DEFAULT NULL,
            \`app_revision\` varchar(100) DEFAULT NULL,
            \`error_message\` text,
            PRIMARY KEY (\`migration_name\`)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
};

const getMigrationRecords = async (connection) => {
    const [rows] = await connection.query(`
        SELECT migration_name, checksum, status, started_at, applied_at,
               execution_ms, applied_by, app_revision, error_message
        FROM \`${TRACKING_TABLE}\`
        ORDER BY migration_name ASC
    `);
    return rows;
};

const getLockName = (databaseName) => `clinic:migrations:${sha256(databaseName).slice(0, 40)}`;

const acquireMigrationLock = async (connection, lockName, timeoutSeconds) => {
    const [rows] = await connection.query(
        'SELECT GET_LOCK(?, ?) AS lock_acquired',
        [lockName, timeoutSeconds]
    );

    if (Number(rows[0]?.lock_acquired) !== 1) {
        throw new Error(`Could not acquire database migration lock within ${timeoutSeconds} seconds`);
    }
};

const releaseMigrationLock = async (connection, lockName) => {
    await connection.query('SELECT RELEASE_LOCK(?) AS lock_released', [lockName]);
};

const closeMigrationConnection = async ({
    connection,
    operationError = null,
    logger = console,
}) => {
    try {
        await connection.end();
    } catch (closeError) {
        if (!operationError) {
            throw closeError;
        }

        logger.error?.(
            `[migrations] Could not close database connection after failure: ${closeError.message}`
        );
    }
};

const assertMigrationHistory = (migrations, records) => {
    const migrationsByName = new Map(migrations.map((migration) => [migration.name, migration]));
    const highestLocalName = migrations.at(-1)?.name || null;
    const databaseAhead = [];

    for (const record of records) {
        const migration = migrationsByName.get(record.migration_name);
        if (!migration) {
            if (
                record.status === 'APPLIED' &&
                (!highestLocalName || record.migration_name > highestLocalName)
            ) {
                databaseAhead.push(record.migration_name);
                continue;
            }

            throw new Error(
                `Migration history has a missing file: ${record.migration_name}. ` +
                'Restore the original file or use an older compatible database snapshot.'
            );
        }

        if (record.status === 'APPLIED' && record.checksum !== migration.checksum) {
            throw new Error(
                `Applied migration was modified: ${record.migration_name}. Create a new migration instead.`
            );
        }

        if (record.status === 'RUNNING' || record.status === 'FAILED') {
            throw new Error(
                `Migration ${record.migration_name} is ${record.status}. ` +
                'Inspect the production schema before repairing its tracking row.'
            );
        }

        if (record.status !== 'APPLIED') {
            throw new Error(`Migration ${record.migration_name} has unknown status ${record.status}`);
        }
    }

    const appliedNames = records
        .filter((record) => record.status === 'APPLIED')
        .map((record) => record.migration_name)
        .sort();
    const highestAppliedName = appliedNames.at(-1) || null;

    if (highestAppliedName) {
        const backdatedPending = migrations.find(
            (migration) =>
                migration.name < highestAppliedName &&
                !records.some((record) => record.migration_name === migration.name)
        );

        if (backdatedPending) {
            throw new Error(
                `Out-of-order migration ${backdatedPending.name} cannot run after ${highestAppliedName}. ` +
                'Create a new migration with a later version.'
            );
        }
    }

    return { databaseAhead };
};

const getAppRevision = (environment = process.env) => (
    environment.SOURCE_COMMIT ||
    environment.COOLIFY_COMMIT_SHA ||
    environment.GIT_COMMIT_SHA ||
    null
);

const runMigrations = async ({
    connection,
    migrations,
    databaseName,
    lockTimeoutSeconds = DEFAULT_LOCK_TIMEOUT_SECONDS,
    logger = console,
    environment = process.env,
}) => {
    const lockName = getLockName(databaseName);
    let lockAcquired = false;

    try {
        await acquireMigrationLock(connection, lockName, lockTimeoutSeconds);
        lockAcquired = true;
        await ensureTrackingTable(connection);

        const records = await getMigrationRecords(connection);
        const { databaseAhead } = assertMigrationHistory(migrations, records);

        if (databaseAhead.length > 0) {
            logger.warn?.(
                `[migrations] Database is ahead of this image by ${databaseAhead.length} migration(s); ` +
                'continuing because applied migrations must be backward-compatible.'
            );
        }

        const appliedNames = new Set(records.map((record) => record.migration_name));
        const pending = migrations.filter((migration) => !appliedNames.has(migration.name));
        const knownAppliedCount = migrations.length - pending.length;

        if (pending.length === 0) {
            logger.log(`[migrations] Database is current (${knownAppliedCount} known migrations applied)`);
            return { applied: 0, skipped: knownAppliedCount, total: migrations.length };
        }

        let applied = 0;
        for (const migration of pending) {
            const startedAt = Date.now();
            logger.log(`[migrations] Applying ${migration.name}`);

            await connection.query(
                `INSERT INTO \`${TRACKING_TABLE}\`
                    (migration_name, checksum, status, started_at, applied_by, app_revision)
                 VALUES (?, ?, 'RUNNING', CURRENT_TIMESTAMP, ?, ?)`,
                [migration.name, migration.checksum, os.hostname(), getAppRevision(environment)]
            );

            try {
                await connection.query(migration.sql);
                const executionMs = Date.now() - startedAt;
                await connection.query(
                    `UPDATE \`${TRACKING_TABLE}\`
                     SET status = 'APPLIED', applied_at = CURRENT_TIMESTAMP,
                         execution_ms = ?, error_message = NULL
                     WHERE migration_name = ?`,
                    [executionMs, migration.name]
                );
                applied += 1;
                logger.log(`[migrations] Applied ${migration.name} (${executionMs}ms)`);
            } catch (error) {
                const executionMs = Date.now() - startedAt;
                const errorMessage = String(error.message || error).slice(0, MAX_ERROR_MESSAGE_LENGTH);

                logger.error(`[migrations] Migration ${migration.name} failed: ${errorMessage}`);

                try {
                    await connection.query(
                        `UPDATE \`${TRACKING_TABLE}\`
                         SET status = 'FAILED', execution_ms = ?, error_message = ?
                         WHERE migration_name = ?`,
                        [executionMs, errorMessage, migration.name]
                    );
                } catch (trackingError) {
                    logger.error(
                        `[migrations] Could not record failure for ${migration.name}: ${trackingError.message}`
                    );
                }

                throw new Error(`Migration ${migration.name} failed: ${errorMessage}`, { cause: error });
            }
        }

        return {
            applied,
            skipped: knownAppliedCount,
            total: migrations.length,
        };
    } finally {
        if (lockAcquired) {
            try {
                await releaseMigrationLock(connection, lockName);
            } catch (error) {
                logger.error(`[migrations] Could not release advisory lock: ${error.message}`);
            }
        }
    }
};

const getMigrationStatus = async ({
    connection,
    migrations,
    databaseName,
    lockTimeoutSeconds = DEFAULT_LOCK_TIMEOUT_SECONDS,
}) => {
    const lockName = getLockName(databaseName);
    let lockAcquired = false;

    try {
        await acquireMigrationLock(connection, lockName, lockTimeoutSeconds);
        lockAcquired = true;
        await ensureTrackingTable(connection);
        const records = await getMigrationRecords(connection);
        const recordsByName = new Map(records.map((record) => [record.migration_name, record]));
        const localNames = new Set(migrations.map((migration) => migration.name));
        const highestLocalName = migrations.at(-1)?.name || null;

        return [
            ...migrations.map((migration) => {
                const record = recordsByName.get(migration.name);
                if (!record) {
                    return { migration: migration.name, status: 'PENDING', checksum_ok: true };
                }
                return {
                    migration: migration.name,
                    status: record.status,
                    checksum_ok: record.checksum === migration.checksum,
                    applied_at: record.applied_at,
                };
            }),
            ...records
                .filter((record) => !localNames.has(record.migration_name))
                .map((record) => ({
                    migration: record.migration_name,
                    status: (
                        record.status === 'APPLIED' &&
                        (!highestLocalName || record.migration_name > highestLocalName)
                    ) ? 'DATABASE_AHEAD' : 'MISSING_FILE',
                    checksum_ok: null,
                    applied_at: record.applied_at,
                })),
        ];
    } finally {
        if (lockAcquired) {
            await releaseMigrationLock(connection, lockName);
        }
    }
};

const runFromEnvironment = async ({ statusOnly = false, environment = process.env } = {}) => {
    const config = getMigrationConfig(environment);
    const migrationsDir = environment.DB_MIGRATIONS_DIR
        ? path.resolve(environment.DB_MIGRATIONS_DIR)
        : path.resolve(__dirname, '..', 'sql', 'migrations');
    const migrations = await discoverMigrations(migrationsDir);
    const connection = await createMigrationConnection(config);
    let operationError = null;

    try {
        if (statusOnly) {
            return getMigrationStatus({
                connection,
                migrations,
                databaseName: config.database,
                lockTimeoutSeconds: config.lockTimeoutSeconds,
            });
        }

        return runMigrations({
            connection,
            migrations,
            databaseName: config.database,
            lockTimeoutSeconds: config.lockTimeoutSeconds,
            environment,
        });
    } catch (error) {
        operationError = error;
        throw error;
    } finally {
        await closeMigrationConnection({ connection, operationError });
    }
};

module.exports = {
    MIGRATION_FILENAME_PATTERN,
    TRACKING_TABLE,
    assertMigrationHistory,
    closeMigrationConnection,
    discoverMigrations,
    getLockName,
    getMigrationConfig,
    getMigrationStatus,
    runFromEnvironment,
    runMigrations,
    sha256,
    validateMigrationSql,
};
