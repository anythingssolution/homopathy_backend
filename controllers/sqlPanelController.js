const path = require('path');
const mysql = require('mysql2');
const { pool } = require('../config/db');
const { env } = require('../config/env');
const AppError = require('../utils/AppError');

const ALLOWED_QUERY_PREFIXES = ['SELECT', 'SHOW', 'DESCRIBE', 'DESC', 'EXPLAIN', 'UPDATE', 'ALTER'];
const MAX_EXECUTION_TIME_MS = 10000;
const EXPORT_BATCH_SIZE = 500;

const normalizeSql = (sql) => String(sql || '').trim().replace(/;+$/u, '').trim();

const getFirstKeyword = (sql) => {
    const match = sql.match(/^([a-z]+)/iu);
    return match ? match[1].toUpperCase() : '';
};

const assertAllowedQuery = (sql) => {
    const normalizedSql = normalizeSql(sql);

    if (!normalizedSql) {
        throw new AppError('SQL query is required.', 400);
    }

    if (normalizedSql.includes(';')) {
        throw new AppError('Please run only one SQL statement at a time.', 400);
    }

    const firstKeyword = getFirstKeyword(normalizedSql);

    if (!ALLOWED_QUERY_PREFIXES.includes(firstKeyword)) {
        throw new AppError(
            'Only these queries are allowed: SELECT, SHOW, DESCRIBE, DESC, EXPLAIN, UPDATE, ALTER.',
            400
        );
    }

    return normalizedSql;
};

const renderSqlPanel = (_req, res) => {
    res.sendFile(path.join(__dirname, '../public/sql-panel.html'));
};

const escapeSqlValue = (value) => {
    if (value && typeof value === 'object' && !(value instanceof Date) && !Buffer.isBuffer(value)) {
        return mysql.escape(JSON.stringify(value));
    }

    return mysql.escape(value);
};

const writeSqlLine = (res, line = '') => {
    res.write(`${line}\n`);
};

const getExportFilename = () => {
    const timestamp = new Date().toISOString().replace(/[:.]/gu, '-');
    const safeDbName = String(env.db.name || 'database').replace(/[^a-z0-9_-]+/giu, '_');

    return `${safeDbName}_${timestamp}.sql`;
};

const exportDatabase = async (_req, res, next) => {
    let connection;
    let responseStarted = false;

    try {
        connection = await pool.getConnection();
        const databaseName = env.db.name;
        const escapedDatabaseName = mysql.escapeId(databaseName);
        const [tables] = await connection.query(
            `SELECT TABLE_NAME AS table_name
            FROM information_schema.TABLES
            WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'
            ORDER BY TABLE_NAME`,
            [databaseName]
        );

        res.setHeader('Content-Type', 'application/sql; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${getExportFilename()}"`);
        responseStarted = true;

        writeSqlLine(res, `-- ${databaseName} database export`);
        writeSqlLine(res, `-- Generated at ${new Date().toISOString()}`);
        writeSqlLine(res);
        writeSqlLine(res, 'SET FOREIGN_KEY_CHECKS=0;');
        writeSqlLine(res, `CREATE DATABASE IF NOT EXISTS ${escapedDatabaseName};`);
        writeSqlLine(res, `USE ${escapedDatabaseName};`);
        writeSqlLine(res);

        try {
            await connection.query('SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ');
            await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT');
        } catch (_error) {
            await connection.query('START TRANSACTION');
        }

        for (const table of tables) {
            const tableName = table.table_name;
            const escapedTableName = mysql.escapeId(tableName);
            const [createRows] = await connection.query(`SHOW CREATE TABLE ${escapedTableName}`);
            const createStatement = createRows[0]?.['Create Table'];

            writeSqlLine(res, `-- Table structure for ${tableName}`);
            writeSqlLine(res, `DROP TABLE IF EXISTS ${escapedTableName};`);
            writeSqlLine(res, `${createStatement};`);
            writeSqlLine(res);
            writeSqlLine(res, `-- Data for ${tableName}`);

            let offset = 0;
            let exportedAnyRows = false;

            while (true) {
                const [rows, fields] = await connection.query(
                    `SELECT * FROM ${escapedTableName} LIMIT ? OFFSET ?`,
                    [EXPORT_BATCH_SIZE, offset]
                );

                if (!rows.length) {
                    break;
                }

                const columns = fields.map((field) => mysql.escapeId(field.name)).join(', ');
                const values = rows.map((row) => {
                    const rowValues = fields.map((field) => escapeSqlValue(row[field.name])).join(', ');

                    return `(${rowValues})`;
                }).join(',\n');

                writeSqlLine(res, `INSERT INTO ${escapedTableName} (${columns}) VALUES`);
                writeSqlLine(res, `${values};`);
                writeSqlLine(res);
                exportedAnyRows = true;
                offset += EXPORT_BATCH_SIZE;
            }

            if (!exportedAnyRows) {
                writeSqlLine(res, `-- No rows in ${tableName}`);
                writeSqlLine(res);
            }
        }

        await connection.query('COMMIT');
        writeSqlLine(res, 'SET FOREIGN_KEY_CHECKS=1;');
        res.end();
    } catch (error) {
        if (connection) {
            try {
                await connection.query('ROLLBACK');
            } catch (_rollbackError) {
                // Response will surface the original export error.
            }
        }

        if (responseStarted) {
            writeSqlLine(res);
            writeSqlLine(res, `-- Export failed: ${error.message}`);
            res.end();
            return;
        }

        next(error);
    } finally {
        if (connection) {
            connection.release();
        }
    }
};

const getSchemaOverview = async (_req, res, next) => {
    try {
        const [rows] = await pool.query(
            `SELECT
                c.TABLE_NAME AS table_name,
                c.COLUMN_NAME AS column_name,
                c.COLUMN_TYPE AS column_type,
                c.IS_NULLABLE AS is_nullable,
                c.COLUMN_KEY AS column_key
            FROM information_schema.COLUMNS c
            WHERE c.TABLE_SCHEMA = ?
            ORDER BY c.TABLE_NAME, c.ORDINAL_POSITION`,
            [env.db.name]
        );

        const tablesMap = new Map();

        rows.forEach((row) => {
            if (!tablesMap.has(row.table_name)) {
                tablesMap.set(row.table_name, {
                    table_name: row.table_name,
                    columns: [],
                });
            }

            tablesMap.get(row.table_name).columns.push({
                column_name: row.column_name,
                column_type: row.column_type,
                is_nullable: row.is_nullable === 'YES',
                column_key: row.column_key || null,
            });
        });

        res.status(200).json({
            success: true,
            database: env.db.name,
            table_count: tablesMap.size,
            tables: Array.from(tablesMap.values()),
        });
    } catch (error) {
        next(error);
    }
};

const executeSqlQuery = async (req, res, next) => {
    const sql = normalizeSql(req.body?.sql);
    let connection;

    try {
        connection = await pool.getConnection();
        const safeSql = assertAllowedQuery(sql);
        const startedAt = Date.now();

        try {
            await connection.query(`SET SESSION max_execution_time = ${MAX_EXECUTION_TIME_MS}`);
        } catch (_error) {
            // Ignore when the database engine does not support this session variable.
        }

        const [rows, fields] = await connection.query(safeSql);
        const durationMs = Date.now() - startedAt;
        const firstKeyword = getFirstKeyword(safeSql);
        const isTabularResult = Array.isArray(rows);

        res.status(200).json({
            success: true,
            sql: safeSql,
            query_type: firstKeyword,
            duration_ms: durationMs,
            row_count: isTabularResult ? rows.length : 0,
            affected_rows: !isTabularResult && Number.isInteger(rows?.affectedRows) ? rows.affectedRows : 0,
            changed_rows: !isTabularResult && Number.isInteger(rows?.changedRows) ? rows.changedRows : 0,
            warning_count: !isTabularResult && Number.isInteger(rows?.warningStatus) ? rows.warningStatus : 0,
            columns: Array.isArray(fields) ? fields.map((field) => field.name) : [],
            rows: isTabularResult ? rows : [],
        });
    } catch (error) {
        next(error);
    } finally {
        if (connection) {
            connection.release();
        }
    }
};

module.exports = {
    renderSqlPanel,
    getSchemaOverview,
    executeSqlQuery,
    exportDatabase,
};
