const requiredEnvVars = [
    'JWT_SECRET',
    'DB_HOST',
    'DB_USER',
    'DB_NAME',
];

const getNumberEnv = (key, fallback) => {
    const rawValue = process.env[key];

    if (rawValue === undefined || rawValue === null || rawValue === '') {
        return fallback;
    }

    const parsed = Number(rawValue);

    if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(`Environment variable ${key} must be a positive number`);
    }

    return parsed;
};

const getStringEnv = (key, fallback = null) => {
    const value = process.env[key];

    if (value === undefined || value === null || String(value).trim() === '') {
        return fallback;
    }

    return String(value).trim();
};

const validateEnv = () => {
    const missing = requiredEnvVars.filter((key) => !getStringEnv(key));

    if (missing.length > 0) {
        throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
    }

    const weakSecretFallbacks = new Set([
        'please_change_this_secret',
        'replace_with_a_long_random_secret',
    ]);

    const jwtSecret = getStringEnv('JWT_SECRET');

    if (weakSecretFallbacks.has(jwtSecret) || jwtSecret.length < 16) {
        throw new Error('JWT_SECRET must be set to a strong secret with at least 16 characters');
    }

    const port = getNumberEnv('PORT', 4000);
    const dbPort = getNumberEnv('DB_PORT', 3306);
    const dbConnectionLimit = getNumberEnv('DB_CONNECTION_LIMIT', 10);
    const otpExpiresInSec = getNumberEnv('OTP_EXPIRES_IN_SEC', 300);
    const otpResendIntervalSec = getNumberEnv('OTP_RESEND_INTERVAL_SEC', 60);
    const authWindowMs = getNumberEnv('AUTH_RATE_LIMIT_WINDOW_MS', 15 * 60 * 1000);
    const authMaxRequests = getNumberEnv('AUTH_RATE_LIMIT_MAX', 20);
    const otpWindowMs = getNumberEnv('OTP_RATE_LIMIT_WINDOW_MS', 10 * 60 * 1000);
    const otpMaxRequests = getNumberEnv('OTP_RATE_LIMIT_MAX', 10);
    const corsOrigin = getStringEnv('CORS_ORIGIN', '*');
    const filesystemDriver = getStringEnv('FILESYSTEM_DRIVER', 'local');

    if (otpResendIntervalSec >= otpExpiresInSec) {
        throw new Error('OTP_RESEND_INTERVAL_SEC must be smaller than OTP_EXPIRES_IN_SEC');
    }

    return {
        port,
        nodeEnv: getStringEnv('NODE_ENV', 'development'),
        jwtSecret,
        registrationTokenSecret: getStringEnv('REGISTRATION_TOKEN_SECRET', jwtSecret),
        forgotPasswordTokenSecret: getStringEnv('FORGOT_PASSWORD_TOKEN_SECRET', jwtSecret),
        accessTokenExpiresIn: getStringEnv('JWT_EXPIRES_IN', '7d'),
        refreshTokenExpiresIn: getStringEnv('JWT_REFRESH_EXPIRES_IN', '7d'),
        db: {
            host: getStringEnv('DB_HOST'),
            port: dbPort,
            user: getStringEnv('DB_USER'),
            password: getStringEnv('DB_PASSWORD', ''),
            name: getStringEnv('DB_NAME'),
            connectionLimit: dbConnectionLimit,
        },
        otp: {
            defaultOtp: getStringEnv('DEFAULT_OTP', '123456'),
            expiresInSec: otpExpiresInSec,
            resendIntervalSec: otpResendIntervalSec,
        },
        whatsapp: {
            accessToken: getStringEnv('WHATSAPP_ACCESS_TOKEN'),
            phoneNumberId: getStringEnv('WHATSAPP_PHONE_NUMBER_ID'),
            apiVersion: getStringEnv('WHATSAPP_API_VERSION', 'v22.0'),
            defaultCountryCode: getStringEnv('WHATSAPP_DEFAULT_COUNTRY_CODE', '91'),
            requestTimeoutMs: getNumberEnv('WHATSAPP_REQUEST_TIMEOUT_MS', 10000),
            welcomeMessage: getStringEnv(
                'WHATSAPP_WELCOME_MESSAGE',
                'dr. homopathy clinic me aapka swagat hai'
            ),
        },
        rateLimit: {
            authWindowMs,
            authMaxRequests,
            otpWindowMs,
            otpMaxRequests,
        },
        storage: {
            driver: filesystemDriver,
            imageMaxBytes: getNumberEnv('CMS_IMAGE_MAX_BYTES', 10 * 1024 * 1024),
            videoMaxBytes: getNumberEnv('CMS_VIDEO_MAX_BYTES', 250 * 1024 * 1024),
            imageOptimizedMaxWidth: getNumberEnv('CMS_IMAGE_OPTIMIZED_MAX_WIDTH', 1600),
            imageThumbnailMaxWidth: getNumberEnv('CMS_IMAGE_THUMB_MAX_WIDTH', 480),
            spaces: {
                key: getStringEnv('DO_SPACES_KEY'),
                secret: getStringEnv('DO_SPACES_SECRET'),
                endpoint: getStringEnv('DO_SPACES_ENDPOINT'),
                fileEndpoint: getStringEnv('DO_SPACES_FILEENDPOINT'),
                region: getStringEnv('DO_SPACES_REGION'),
                bucket: getStringEnv('DO_SPACES_BUCKET'),
            },
        },
        corsOrigin,
    };
};

const env = validateEnv();

module.exports = {
    env,
    getStringEnv,
    getNumberEnv,
};
