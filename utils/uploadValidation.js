const AppError = require('./AppError');
const { importDependency } = require('./dependencyGuard');
const { hasDoubleExtension } = require('./fileNaming');

const IMAGE_MIME_TO_EXT = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
};

const VIDEO_MIME_TO_EXT = {
    'video/mp4': 'mp4',
    'video/quicktime': 'mov',
    'video/x-msvideo': 'avi',
    'video/x-matroska': 'mkv',
    'video/webm': 'webm',
};

let fileTypeModulePromise = null;

const getFileTypeFromBuffer = async () => {
    if (!fileTypeModulePromise) {
        fileTypeModulePromise = importDependency('file-type');
    }

    const fileTypeModule = await fileTypeModulePromise;
    return fileTypeModule.fileTypeFromBuffer;
};

const detectFileDetails = async (file) => {
    if (!file?.buffer || !Buffer.isBuffer(file.buffer)) {
        throw new AppError('Uploaded file buffer is missing', 400);
    }

    const fileTypeFromBuffer = await getFileTypeFromBuffer();
    const detected = await fileTypeFromBuffer(file.buffer);
    if (!detected) {
        throw new AppError('Unable to detect uploaded file type', 400);
    }

    return detected;
};

const validateSingleExtension = (originalName) => {
    if (hasDoubleExtension(originalName)) {
        throw new AppError(`Please upload a valid file with a single extension: ${originalName}`, 400);
    }
};

const validateImageUpload = async (file, maxBytes) => {
    validateSingleExtension(file?.originalname);

    if (!file) {
        throw new AppError('Image file is required', 400);
    }

    if (file.size > maxBytes) {
        throw new AppError(`Image file size must be <= ${maxBytes} bytes`, 400);
    }

    const detected = await detectFileDetails(file);
    const ext = IMAGE_MIME_TO_EXT[detected.mime];

    if (!ext) {
        throw new AppError('Only JPG, PNG, or WEBP images are allowed', 400);
    }

    return {
        mime: detected.mime,
        ext,
    };
};

const validateVideoUpload = async (file, maxBytes) => {
    validateSingleExtension(file?.originalname);

    if (!file) {
        throw new AppError('Video file is required', 400);
    }

    if (file.size > maxBytes) {
        throw new AppError(`Video file size must be <= ${maxBytes} bytes`, 400);
    }

    const detected = await detectFileDetails(file);
    const ext = VIDEO_MIME_TO_EXT[detected.mime];

    if (!ext) {
        throw new AppError('Only MP4, MOV, AVI, MKV, or WEBM videos are allowed', 400);
    }

    return {
        mime: detected.mime,
        ext,
    };
};

module.exports = {
    validateImageUpload,
    validateVideoUpload,
    IMAGE_MIME_TO_EXT,
};
