const AppError = require('../utils/AppError');
const { env } = require('../config/env');
const { requireDependency } = require('../utils/dependencyGuard');

let clinicalDocumentUploadMiddleware = null;

const getClinicalDocumentUploadMiddleware = () => {
    if (!clinicalDocumentUploadMiddleware) {
        const multer = requireDependency('multer');

        clinicalDocumentUploadMiddleware = multer({
            storage: multer.memoryStorage(),
            limits: {
                fileSize: env.storage.clinicalDocumentMaxBytes,
                files: 1,
            },
        }).single('file');
    }

    return clinicalDocumentUploadMiddleware;
};

const uploadClinicalDocumentFile = (req, res, next) => {
    let middleware;

    try {
        middleware = getClinicalDocumentUploadMiddleware();
    } catch (error) {
        return next(error);
    }

    return middleware(req, res, (error) => {
        if (!error) {
            return next();
        }

        if (error.code === 'LIMIT_FILE_SIZE') {
            return next(new AppError('Uploaded clinical document exceeds allowed size limit', 400));
        }

        return next(new AppError(error.message || 'Clinical document upload failed', 400));
    });
};

module.exports = {
    uploadClinicalDocumentFile,
};
