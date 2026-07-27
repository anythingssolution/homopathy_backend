const AppError = require('../utils/AppError');
const { env } = require('../config/env');
const { requireDependency } = require('../utils/dependencyGuard');

const buildMulter = (maxBytes) => {
    const multer = requireDependency('multer');

    return multer({
        storage: multer.memoryStorage(),
        limits: {
            fileSize: maxBytes,
            files: 2,
        },
    });
};

let imageUploadMiddleware = null;
let videoUploadMiddleware = null;

const getImageUploadMiddleware = () => {
    if (!imageUploadMiddleware) {
        imageUploadMiddleware = buildMulter(env.storage.imageMaxBytes).single('file');
    }

    return imageUploadMiddleware;
};

const getVideoUploadMiddleware = () => {
    if (!videoUploadMiddleware) {
        videoUploadMiddleware = buildMulter(env.storage.videoMaxBytes).fields([
            { name: 'file', maxCount: 1 },
            { name: 'poster', maxCount: 1 },
        ]);
    }

    return videoUploadMiddleware;
};

const runUploadMiddleware = (getMiddleware) => (req, res, next) => {
    let middleware;

    try {
        middleware = getMiddleware();
    } catch (error) {
        return next(error);
    }

    return middleware(req, res, (error) => {
        if (!error) {
            return next();
        }

        if (error.code === 'LIMIT_FILE_SIZE') {
            return next(new AppError('Uploaded file exceeds allowed size limit', 400));
        }

        return next(new AppError(error.message || 'File upload failed', 400));
    });
};

module.exports = {
    uploadCmsImageFile: runUploadMiddleware(getImageUploadMiddleware),
    uploadCmsVideoFiles: runUploadMiddleware(getVideoUploadMiddleware),
};
