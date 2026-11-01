const isRetryableTransactionError = error => ['ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT'].includes(error?.code)
    || [1213, 1205].includes(Number(error?.errno));

module.exports = { isRetryableTransactionError };
