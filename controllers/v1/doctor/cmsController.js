const asyncHandler = require('../../../utils/asyncHandler');
const {
    getHomepageCmsPayload,
    listCmsSection,
    createCmsSectionItem,
    updateCmsSectionItem,
    removeCmsSectionItem,
} = require('../../../services/homepageCmsService');

const createSectionHandlers = (section) => ({
    list: asyncHandler(async (_req, res) => {
        const data = await listCmsSection(section);
        return res.status(200).json({
            success: true,
            message: `${section} CMS fetched successfully`,
            data,
        });
    }),
    create: asyncHandler(async (req, res) => {
        const data = await createCmsSectionItem(section, req.body, req.user?.id || null);
        return res.status(201).json({
            success: true,
            message: `${section} CMS item created successfully`,
            data,
        });
    }),
    update: asyncHandler(async (req, res) => {
        const data = await updateCmsSectionItem(section, req.params.id, req.body, req.user?.id || null);
        return res.status(200).json({
            success: true,
            message: `${section} CMS item updated successfully`,
            data,
        });
    }),
    remove: asyncHandler(async (req, res) => {
        await removeCmsSectionItem(section, req.params.id);
        return res.status(200).json({
            success: true,
            message: `${section} CMS item deleted successfully`,
        });
    }),
});

const heroHandlers = createSectionHandlers('hero');
const testimonialHandlers = createSectionHandlers('testimonials');
const galleryHandlers = createSectionHandlers('gallery');

const getDoctorHomepageCms = asyncHandler(async (_req, res) => {
    const data = await getHomepageCmsPayload({ onlyActive: false });
    return res.status(200).json({
        success: true,
        message: 'Doctor homepage CMS fetched successfully',
        data,
    });
});

module.exports = {
    getDoctorHomepageCms,
    listHeroCms: heroHandlers.list,
    createHeroCms: heroHandlers.create,
    updateHeroCms: heroHandlers.update,
    deleteHeroCms: heroHandlers.remove,
    listTestimonialsCms: testimonialHandlers.list,
    createTestimonialsCms: testimonialHandlers.create,
    updateTestimonialsCms: testimonialHandlers.update,
    deleteTestimonialsCms: testimonialHandlers.remove,
    listGalleryCms: galleryHandlers.list,
    createGalleryCms: galleryHandlers.create,
    updateGalleryCms: galleryHandlers.update,
    deleteGalleryCms: galleryHandlers.remove,
};
