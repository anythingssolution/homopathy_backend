const fs = require('fs');
const path = require('path');

const LOG_DIR = path.join(__dirname, '..', 'logs');

const maskSensitiveFields = (value) => {
    if (!value || typeof value !== 'object') {
        return value;
    }

    const clone = Array.isArray(value) ? [...value] : { ...value };

    Object.keys(clone).forEach((key) => {
        if (/password|token|authorization/i.test(key)) {
            clone[key] = '[REDACTED]';
            return;
        }

        if (typeof clone[key] === 'object' && clone[key] !== null) {
            clone[key] = maskSensitiveFields(clone[key]);
        }
    });

    return clone;
};

const writeErrorLog = async ({ req, err, statusCode }) => {
    try {
        await fs.promises.mkdir(LOG_DIR, { recursive: true });

        const date = new Date().toISOString().split('T')[0];
        const filePath = path.join(LOG_DIR, `error-${date}.log`);

        const payload = {
            timestamp: new Date().toISOString(),
            statusCode,
            message: err.message,
            errorName: err.name,
            errorCode: err.code || null,
            errorErrno: err.errno || null,
            errorSqlState: err.sqlState || null,
            errorSqlMessage: err.sqlMessage || null,
            errorSql: err.sql || null,
            errorConstraint: err.constraint || null,
            errorDetails: err.details || null,
            stack: err.stack,
            method: req.method,
            path: req.originalUrl,
            ip: req.ip || req.socket?.remoteAddress,
            query: maskSensitiveFields(req.query),
            body: maskSensitiveFields(req.body),
            rawError: err.originalError
                ? {
                      message: err.originalError.message,
                      name: err.originalError.name,
                      code: err.originalError.code || null,
                      errno: err.originalError.errno || null,
                      sqlState: err.originalError.sqlState || null,
                      sqlMessage: err.originalError.sqlMessage || null,
                      sql: err.originalError.sql || null,
                      constraint: err.originalError.constraint || null,
                      stack: err.originalError.stack || null,
                  }
                : null,
        };

        await fs.promises.appendFile(filePath, `${JSON.stringify(payload)}\n`, 'utf8');
    } catch (logError) {
        console.error('Error log write failed:', logError.message);
    }
};

module.exports = {
    writeErrorLog,
};
