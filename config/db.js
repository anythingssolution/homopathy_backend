const mysql = require('mysql2/promise');
const { env } = require('./env');
const { isRetryableTransactionError } = require('../utils/transactionRetry');

const pool = mysql.createPool({
    host: env.db.host,
    port: env.db.port,
    user: env.db.user,
    password: env.db.password,
    database: env.db.name,
    waitForConnections: true,
    connectionLimit: env.db.connectionLimit,
    queueLimit: 0,
    enableKeepAlive: true,
    keepAliveInitialDelay: 0,
    timezone: '+05:30',
});

const query = async (sql, params = []) => {
    const [rows] = await pool.query(sql, params);
    return rows;
};

// Retry is opt-in: callbacks with non-transactional side effects must not replay.
const withTransaction = async (handler, { maxRetries = 0, retryDelayMs = 25 } = {}) => {
    const retries = Math.min(3, Math.max(0, Math.floor(Number(maxRetries) || 0)));
    for (let attempt = 0; ; attempt += 1) {
        const connection = await pool.getConnection();
        let retry = false;
        try {
            await connection.beginTransaction();
            const result = await handler(connection);
            await connection.commit();
            return result;
        } catch (error) {
            try { await connection.rollback(); } catch { throw error; }
            retry = attempt < retries && isRetryableTransactionError(error);
            if (!retry) throw error;
        } finally {
            connection.release();
        }
        if (retry) await new Promise(resolve => setTimeout(resolve, Math.max(0, retryDelayMs) * (attempt + 1) + Math.floor(Math.random() * 15)));
    }
};

const testConnection = async () => {
    const connection = await pool.getConnection();
    try {
        await connection.ping();
    } finally {
        connection.release();
    }
};

module.exports = {
    pool,
    query,
    withTransaction,
    testConnection,
};
