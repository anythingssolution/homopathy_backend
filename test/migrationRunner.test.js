const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const test = require('node:test');

const {
    closeMigrationConnection,
    discoverMigrations,
    getMigrationConfig,
    runMigrations,
    runWithMigrationConnection,
    sha256,
    validateMigrationSql,
} = require('../scripts/migrationRunner');

const silentLogger = {
    log: () => {},
    error: () => {},
    warn: () => {},
};

class FakeConnection {
    constructor({ records = [], lockResult = 1, failSql = null } = {}) {
        this.records = records.map((record) => ({ ...record }));
        this.lockResult = lockResult;
        this.failSql = failSql;
        this.executedMigrations = [];
        this.releaseCount = 0;
    }

    async query(sql, params = []) {
        const normalized = String(sql).replace(/\s+/g, ' ').trim();

        if (normalized.startsWith('SELECT GET_LOCK')) {
            return [[{ lock_acquired: this.lockResult }], []];
        }

        if (normalized.startsWith('SELECT RELEASE_LOCK')) {
            this.releaseCount += 1;
            return [[{ lock_released: 1 }], []];
        }

        if (normalized.includes('CREATE TABLE IF NOT EXISTS `schema_migrations`')) {
            return [[], []];
        }

        if (normalized.startsWith('SELECT migration_name, checksum, status')) {
            return [this.records.map((record) => ({ ...record })), []];
        }

        if (normalized.startsWith('INSERT INTO `schema_migrations`')) {
            this.records.push({
                migration_name: params[0],
                checksum: params[1],
                status: 'RUNNING',
                started_at: new Date(),
                applied_at: null,
                execution_ms: null,
                applied_by: params[2],
                app_revision: params[3],
                error_message: null,
            });
            return [{ affectedRows: 1 }, []];
        }

        if (normalized.startsWith("UPDATE `schema_migrations` SET status = 'APPLIED'")) {
            const record = this.records.find((item) => item.migration_name === params[1]);
            record.status = 'APPLIED';
            record.execution_ms = params[0];
            record.applied_at = new Date();
            record.error_message = null;
            return [{ affectedRows: 1 }, []];
        }

        if (normalized.startsWith("UPDATE `schema_migrations` SET status = 'FAILED'")) {
            const record = this.records.find((item) => item.migration_name === params[2]);
            record.status = 'FAILED';
            record.execution_ms = params[0];
            record.error_message = params[1];
            return [{ affectedRows: 1 }, []];
        }

        this.executedMigrations.push(sql);
        if (sql === this.failSql) {
            throw new Error('simulated SQL failure');
        }

        return [[], []];
    }
}

const buildMigration = (name, sql) => ({
    name,
    version: name.slice(0, 14),
    checksum: sha256(Buffer.from(sql)),
    sql,
});

test('discovers only managed SQL files in lexical order', async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'clinic-migrations-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));

    const managedDir = path.join(root, 'sql', 'migrations');
    await fs.mkdir(managedDir, { recursive: true });
    await fs.writeFile(path.join(root, 'sql', 'master_tables.sql'), 'DROP TABLE patients;');
    await fs.writeFile(path.join(root, 'sql', '2026-01-01_legacy.sql'), 'DROP TABLE visits;');
    await fs.writeFile(path.join(managedDir, 'README.md'), 'not executable');
    await fs.writeFile(path.join(managedDir, '2026-08-11_002_second.sql'), 'SELECT 2;');
    await fs.writeFile(path.join(managedDir, '2026-08-11_001_first.sql'), 'SELECT 1;');

    const migrations = await discoverMigrations(managedDir);

    assert.deepEqual(
        migrations.map((migration) => migration.name),
        ['2026-08-11_001_first.sql', '2026-08-11_002_second.sql']
    );
    assert.equal(migrations.some((migration) => migration.sql.includes('DROP TABLE')), false);
});

test('rejects duplicate versions and unsupported client directives', async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'clinic-migrations-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));

    await fs.writeFile(path.join(root, '2026-08-11_001_first.sql'), 'SELECT 1;');
    await fs.writeFile(path.join(root, '2026-08-11_001_duplicate.sql'), 'SELECT 2;');

    await assert.rejects(() => discoverMigrations(root), /Duplicate migration version/);
    assert.throws(
        () => validateMigrationSql('unsafe.sql', 'DELIMITER $$\nSELECT 1$$'),
        /unsupported DELIMITER/
    );
    assert.throws(
        () => validateMigrationSql('unsafe.sql', 'USE another_database;'),
        /unsupported USE/
    );
    assert.throws(
        () => validateMigrationSql('unsafe.sql', 'SELECT 1; DROP DATABASE clinic;'),
        /must not create or drop a database/
    );
});

test('applies each migration once and records its checksum', async () => {
    const sql = "CREATE TABLE sample (id int); INSERT INTO sample VALUES (1);";
    const migration = buildMigration('2026-08-11_001_sample.sql', sql);
    const connection = new FakeConnection();

    const first = await runMigrations({
        connection,
        migrations: [migration],
        databaseName: 'clinic',
        logger: silentLogger,
    });
    const second = await runMigrations({
        connection,
        migrations: [migration],
        databaseName: 'clinic',
        logger: silentLogger,
    });

    assert.deepEqual(first, { applied: 1, skipped: 0, total: 1 });
    assert.deepEqual(second, { applied: 0, skipped: 1, total: 1 });
    assert.deepEqual(connection.executedMigrations, [sql]);
    assert.equal(connection.records[0].status, 'APPLIED');
    assert.equal(connection.records[0].checksum, migration.checksum);
    assert.equal(connection.releaseCount, 2);
});

test('fails before executing pending SQL when applied checksum changed', async () => {
    const applied = buildMigration('2026-08-11_001_applied.sql', 'SELECT 1;');
    const pending = buildMigration('2026-08-11_002_pending.sql', 'SELECT 2;');
    const connection = new FakeConnection({
        records: [{
            migration_name: applied.name,
            checksum: sha256(Buffer.from('SELECT changed;')),
            status: 'APPLIED',
        }],
    });

    await assert.rejects(
        () => runMigrations({
            connection,
            migrations: [applied, pending],
            databaseName: 'clinic',
            logger: silentLogger,
        }),
        /Applied migration was modified/
    );
    assert.deepEqual(connection.executedMigrations, []);
    assert.equal(connection.releaseCount, 1);
});

test('rejects a backdated pending migration after a newer migration was applied', async () => {
    const older = buildMigration('2026-08-11_001_older.sql', 'SELECT 1;');
    const newer = buildMigration('2026-08-11_002_newer.sql', 'SELECT 2;');
    const connection = new FakeConnection({
        records: [{
            migration_name: newer.name,
            checksum: newer.checksum,
            status: 'APPLIED',
        }],
    });

    await assert.rejects(
        () => runMigrations({
            connection,
            migrations: [older, newer],
            databaseName: 'clinic',
            logger: silentLogger,
        }),
        /Out-of-order migration/
    );
    assert.deepEqual(connection.executedMigrations, []);
});

test('allows an older image to start when the database has a newer applied migration', async () => {
    const local = buildMigration('2026-08-11_001_local.sql', 'SELECT 1;');
    const newer = buildMigration('2026-08-11_002_newer.sql', 'SELECT 2;');
    const connection = new FakeConnection({
        records: [
            { migration_name: local.name, checksum: local.checksum, status: 'APPLIED' },
            { migration_name: newer.name, checksum: newer.checksum, status: 'APPLIED' },
        ],
    });

    const result = await runMigrations({
        connection,
        migrations: [local],
        databaseName: 'clinic',
        logger: silentLogger,
    });

    assert.deepEqual(result, { applied: 0, skipped: 1, total: 1 });
    assert.deepEqual(connection.executedMigrations, []);
});

test('still rejects a missing migration inside the image history', async () => {
    const first = buildMigration('2026-08-11_001_first.sql', 'SELECT 1;');
    const third = buildMigration('2026-08-11_003_third.sql', 'SELECT 3;');
    const connection = new FakeConnection({
        records: [
            { migration_name: first.name, checksum: first.checksum, status: 'APPLIED' },
            {
                migration_name: '2026-08-11_002_missing.sql',
                checksum: sha256(Buffer.from('SELECT 2;')),
                status: 'APPLIED',
            },
            { migration_name: third.name, checksum: third.checksum, status: 'APPLIED' },
        ],
    });

    await assert.rejects(
        () => runMigrations({
            connection,
            migrations: [first, third],
            databaseName: 'clinic',
            logger: silentLogger,
        }),
        /migration history has a missing file/i
    );
});

test('records a failed migration, stops later files, and releases the lock', async () => {
    const first = buildMigration('2026-08-11_001_fails.sql', 'INVALID SQL;');
    const second = buildMigration('2026-08-11_002_never.sql', 'SELECT 2;');
    const connection = new FakeConnection({ failSql: first.sql });

    await assert.rejects(
        () => runMigrations({
            connection,
            migrations: [first, second],
            databaseName: 'clinic',
            logger: silentLogger,
        }),
        /simulated SQL failure/
    );

    assert.deepEqual(connection.executedMigrations, [first.sql]);
    assert.equal(connection.records[0].status, 'FAILED');
    assert.match(connection.records[0].error_message, /simulated SQL failure/);
    assert.equal(connection.releaseCount, 1);
});

test('blocks stale failed or running records rather than replaying partial DDL', async () => {
    const migration = buildMigration('2026-08-11_001_partial.sql', 'ALTER TABLE sample ADD x int;');

    for (const status of ['FAILED', 'RUNNING']) {
        const connection = new FakeConnection({
            records: [{
                migration_name: migration.name,
                checksum: migration.checksum,
                status,
            }],
        });

        await assert.rejects(
            () => runMigrations({
                connection,
                migrations: [migration],
                databaseName: 'clinic',
                logger: silentLogger,
            }),
            new RegExp(`is ${status}`)
        );
        assert.deepEqual(connection.executedMigrations, []);
    }
});

test('does not proceed when the advisory lock cannot be acquired', async () => {
    const migration = buildMigration('2026-08-11_001_sample.sql', 'SELECT 1;');
    const connection = new FakeConnection({ lockResult: 0 });

    await assert.rejects(
        () => runMigrations({
            connection,
            migrations: [migration],
            databaseName: 'clinic',
            logger: silentLogger,
            lockTimeoutSeconds: 1,
        }),
        /Could not acquire database migration lock/
    );
    assert.deepEqual(connection.executedMigrations, []);
    assert.equal(connection.releaseCount, 0);
});

test('migration config validates required DB values without requiring JWT settings', () => {
    const config = getMigrationConfig({
        DB_HOST: 'mysql',
        DB_PORT: '3306',
        DB_USER: 'clinic_user',
        DB_PASSWORD: 'secret',
        DB_NAME: 'clinic',
    });

    assert.equal(config.host, 'mysql');
    assert.equal(config.database, 'clinic');
    assert.equal(config.port, 3306);
    assert.throws(
        () => getMigrationConfig({ DB_HOST: 'mysql' }),
        /DB_USER, DB_NAME/
    );
});

test('connection cleanup does not hide the migration failure', async () => {
    const primaryError = new Error('original migration failure');
    const logged = [];
    const connection = {
        end: async () => {
            throw new Error("Can't add new command when connection is in closed state");
        },
    };

    await assert.doesNotReject(() => closeMigrationConnection({
        connection,
        operationError: primaryError,
        logger: { error: (message) => logged.push(message) },
    }));
    assert.match(logged[0], /Could not close database connection after failure/);
});

test('connection cleanup still reports an unexpected close failure after success', async () => {
    const connection = {
        end: async () => {
            throw new Error('unexpected close failure');
        },
    };

    await assert.rejects(
        () => closeMigrationConnection({ connection }),
        /unexpected close failure/
    );
});

test('waits for the migration operation before closing its connection', async () => {
    let releaseOperation;
    let closed = false;
    const gate = new Promise((resolve) => {
        releaseOperation = resolve;
    });
    const connection = {
        end: async () => {
            closed = true;
        },
    };

    const pending = runWithMigrationConnection({
        connection,
        operation: async () => {
            await gate;
            assert.equal(closed, false);
            return 'complete';
        },
    });

    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(closed, false);

    releaseOperation();
    assert.equal(await pending, 'complete');
    assert.equal(closed, true);
});
