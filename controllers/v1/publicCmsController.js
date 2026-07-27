const asyncHandler = require('../../utils/asyncHandler');
const { getHomepageCmsPayload, listPublicGallery } = require('../../services/homepageCmsService');

const getPublicHomepageCms = asyncHandler(async (_req, res) => {
    const data = await getHomepageCmsPayload({ onlyActive: true });
    return res.status(200).json({
        success: true,
        message: 'Homepage CMS fetched successfully',
        data,
    });
});

const getPublicGalleryCms = asyncHandler(async (req, res) => {
    const data = await listPublicGallery({
        category: req.query.category,
    });

    return res.status(200).json({
        success: true,
        message: 'Gallery CMS fetched successfully',
        data,
    });
});

module.exports = {
    getPublicHomepageCms,
    getPublicGalleryCms,
};
