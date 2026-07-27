const AppError = require('../../../utils/AppError');
const asyncHandler = require('../../../utils/asyncHandler');
const { uploadCmsImageAsset, uploadCmsVideoAsset } = require('../../../services/cmsMediaStorageService');

const getSectionFromQuery = (req) => String(req.query.section || '').trim().toLowerCase();

const uploadDoctorCmsImage = asyncHandler(async (req, res) => {
    const section = getSectionFromQuery(req);

    if (!req.file) {
        throw new AppError('Multipart field "file" is required', 400);
    }

    const data = await uploadCmsImageAsset({
        file: req.file,
        section,
    });

    return res.status(201).json({
        success: true,
        message: 'CMS image uploaded successfully',
        data,
    });
});

const uploadDoctorCmsVideo = asyncHandler(async (req, res) => {
    const section = getSectionFromQuery(req);
    const file = Array.isArray(req.files?.file) ? req.files.file[0] : null;
    const poster = Array.isArray(req.files?.poster) ? req.files.poster[0] : null;

    if (!file) {
        throw new AppError('Multipart field "file" is required', 400);
    }

    const data = await uploadCmsVideoAsset({
        file,
        posterFile: poster,
        section,
    });

    return res.status(201).json({
        success: true,
        message: 'CMS video uploaded successfully',
        data,
    });
});

module.exports = {
    uploadDoctorCmsImage,
    uploadDoctorCmsVideo,
};
