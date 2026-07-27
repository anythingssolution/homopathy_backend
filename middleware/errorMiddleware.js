const AppError = require('../utils/AppError');
const { env } = require('../config/env');
const { writeErrorLog } = require('../utils/errorLogger');

const createDatabaseAppError = (message, statusCode, err, details = null) => {
    const appError = new AppError(message, statusCode);
    appError.originalError = err;
    appError.details = details || {
        db_code: err?.code || null,
        db_errno: err?.errno || null,
        db_sql_state: err?.sqlState || null,
        db_message: err?.sqlMessage || err?.message || null,
    };

    return appError;
};

const normalizeError = (err) => {
    if (err && err.code === 'ER_DUP_ENTRY') {
        return createDatabaseAppError(
            'Duplicate value found. Please use a different value.',
            409,
            err
        );
    }

    if (err && err.code === 'ER_NO_REFERENCED_ROW_2') {
        return createDatabaseAppError(
            'Related record not found. Please check input data.',
            400,
            err
        );
    }

    if (err && err.code === 'ER_BAD_NULL_ERROR') {
        return createDatabaseAppError(
            'Required database field is missing.',
            400,
            err
        );
    }

    if (err && err.code === 'ER_DATA_TOO_LONG') {
        return createDatabaseAppError(
            'Input value is too long for one of the fields.',
            400,
            err
        );
    }

    return err;
};

const notFound = (req, _res, next) => {
    next(new AppError(`Route not found: ${req.method} ${req.originalUrl}`, 404));
};

const globalErrorHandler = async (err, req, res, _next) => {
    const normalizedError = normalizeError(err);
    const statusCode = normalizedError.statusCode || 500;
    const isOperational = normalizedError.isOperational || false;

    await writeErrorLog({
        req,
        err: normalizedError,
        statusCode,
    });

    const response = {
        success: false,
        message:
            isOperational && normalizedError.message
                ? normalizedError.message
                : 'Something went wrong on server. Please try again later.',
        path: req.originalUrl,
        method: req.method,
    };

    if (normalizedError.details) {
        response.details = normalizedError.details;
    }

    if (env.nodeEnv !== 'production') {
        response.error = normalizedError.message;
        response.stack = normalizedError.stack;
        if (normalizedError.originalError) {
            response.debug = {
                original_message: normalizedError.originalError.message,
                original_code: normalizedError.originalError.code || null,
                original_errno: normalizedError.originalError.errno || null,
                original_sql_state: normalizedError.originalError.sqlState || null,
                original_sql_message: normalizedError.originalError.sqlMessage || null,
            };
        }
    }

    res.status(statusCode).json(response);
};

module.exports = {
    notFound,
    globalErrorHandler,
};
