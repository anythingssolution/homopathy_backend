const { env } = require('../config/env');
const AppError = require('../utils/AppError');

const requireOpsFeature = (featureName) => (_req, res, next) => {
    if (!env.ops?.[featureName]) {
        return next(new AppError('Resource not found', 404));
    }

    res.setHeader('Cache-Control', 'no-store');
    return next();
};

const authorizeOpsUser = (req, _res, next) => {
    const userUuid = String(req.user?.uuid || '').trim().toLowerCase();

    if (!userUuid || !env.ops.allowedUserUuids.includes(userUuid)) {
        return next(new AppError('You are not authorized to access operations tools', 403));
    }

    return next();
};

module.exports = {
    requireOpsFeature,
    authorizeOpsUser,
};
