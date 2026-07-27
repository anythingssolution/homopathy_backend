const { env } = require('./env');
const { requireDependency } = require('../utils/dependencyGuard');

const isSpacesDriver = () => String(env.storage?.driver || '').trim().toLowerCase() === 'spaces';

const ensureSpacesConfigured = () => {
    const spaces = env.storage?.spaces || {};
    const missing = ['key', 'secret', 'endpoint', 'fileEndpoint', 'region', 'bucket']
        .filter((field) => !spaces[field]);

    if (missing.length > 0) {
        throw new Error(`Missing DigitalOcean Spaces configuration: ${missing.join(', ')}`);
    }
};

const createSpacesClient = () => {
    const { S3Client } = requireDependency('@aws-sdk/client-s3');

    ensureSpacesConfigured();

    return new S3Client({
        region: env.storage.spaces.region,
        endpoint: env.storage.spaces.endpoint,
        forcePathStyle: false,
        credentials: {
            accessKeyId: env.storage.spaces.key,
            secretAccessKey: env.storage.spaces.secret,
        },
    });
};

let cachedSpacesClient = null;

const getSpacesClient = () => {
    if (!cachedSpacesClient) {
        cachedSpacesClient = createSpacesClient();
    }

    return cachedSpacesClient;
};

module.exports = {
    isSpacesDriver,
    ensureSpacesConfigured,
    getSpacesClient,
};
