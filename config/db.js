const mysql = require('mysql2/promise');
const { env } = require('./env');

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

const withTransaction = async (handler) => {
    const connection = await pool.getConnection();

    try {
        await connection.beginTransaction();
        const result = await handler(connection);
        await connection.commit();
        return result;
    } catch (error) {
        await connection.rollback();
        throw error;
    } finally {
        connection.release();
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
