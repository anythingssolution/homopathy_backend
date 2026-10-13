const fs = require('fs/promises');
const path = require('path');
const { env } = require('../config/env');
const AppError = require('../utils/AppError');
const { buildSafeFilename } = require('../utils/fileNaming');
const { validateImageUpload } = require('../utils/uploadValidation');
const { requireDependency } = require('../utils/dependencyGuard');

const UPLOADS_ROOT = path.join(__dirname, '..', 'uploads');
const PROFILE_IMAGES_ROOT = path.join(UPLOADS_ROOT, 'profile-images');

const getSharp = () => requireDependency('sharp');

const toRoleFolder = (roleCode) => {
    const normalized = String(roleCode || '').trim().toUpperCase();
    if (normalized === 'DOC') return 'doctors';
    if (normalized === 'REC') return 'receptionists';
    if (normalized === 'MED') return 'medical';
    return 'patients';
};

const uploadProfileImage = async ({ file, userId, roleCode }) => {
    if (!userId) {
        throw new AppError('User id is required for profile image upload', 400);
    }

    const detected = await validateImageUpload(file, env.storage.imageMaxBytes);
    const sharp = getSharp();
    const image = sharp(file.buffer, { failOnError: true });
    const metadata = await image.metadata();
    const optimizedBuffer = await image
        .rotate()
        .resize({ width: 640, height: 640, fit: 'cover', withoutEnlargement: true })
        .webp({ quality: 88 })
        .toBuffer();

    const roleFolder = toRoleFolder(roleCode);
    const userFolder = path.join(PROFILE_IMAGES_ROOT, roleFolder, String(userId));
    await fs.mkdir(userFolder, { recursive: true });

    const filename = buildSafeFilename(file.originalname, 'webp', 'profile-image');
    const absolutePath = path.join(userFolder, filename);
    await fs.writeFile(absolutePath, optimizedBuffer);

    return {
        profile_image_url: `/uploads/profile-images/${roleFolder}/${userId}/${filename}`,
        profile_image_key: `profile-images/${roleFolder}/${userId}/${filename}`,
        profile_image_mime_type: 'image/webp',
        profile_image_size: optimizedBuffer.length,
        profile_image_width: metadata.width || null,
        profile_image_height: metadata.height || null,
        original_mime_type: detected.mime,
    };
};

const removeProfileImage = async (profileImageKey) => {
    const normalizedKey = String(profileImageKey || '').trim();
    if (!normalizedKey || normalizedKey.includes('..') || path.isAbsolute(normalizedKey)) {
        return false;
    }

    const absolutePath = path.join(UPLOADS_ROOT, normalizedKey);
    const relativePath = path.relative(UPLOADS_ROOT, absolutePath);
    if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
        return false;
    }

    try {
        await fs.unlink(absolutePath);
        return true;
    } catch (error) {
        if (error?.code === 'ENOENT') {
            return false;
        }
        throw error;
    }
};

module.exports = {
    UPLOADS_ROOT,
    uploadProfileImage,
    removeProfileImage,
};
