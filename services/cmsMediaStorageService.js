const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { env } = require('../config/env');
const AppError = require('../utils/AppError');
const { isSpacesDriver, ensureSpacesConfigured, getSpacesClient } = require('../config/storage');
const { requireDependency } = require('../utils/dependencyGuard');
const { buildSafeFilename } = require('../utils/fileNaming');
const { validateImageUpload, validateVideoUpload } = require('../utils/uploadValidation');

const execFileAsync = promisify(execFile);

const IMAGE_SECTIONS = new Set(['hero', 'testimonials', 'gallery']);
const VIDEO_SECTIONS = new Set(['gallery']);

const getDateParts = () => {
    const now = new Date();
    const year = String(now.getFullYear());
    const month = String(now.getMonth() + 1).padStart(2, '0');
    return { year, month };
};

const CMS_STORAGE_ROOT = 'homopathy-clinic';

const buildCmsBasePath = (section, bucketType) => {
    const { year, month } = getDateParts();
    return `${CMS_STORAGE_ROOT}/cms/${section}/${bucketType}/${year}/${month}`;
};

const getPublicUrlForKey = (key) => {
    const base = String(env.storage.spaces.fileEndpoint || '').replace(/\/+$/, '');
    return `${base}/${key}`;
};

const getSharp = () => requireDependency('sharp');

const getUploadClass = () => {
    const { Upload } = requireDependency('@aws-sdk/lib-storage');
    return Upload;
};

const uploadBufferToSpaces = async ({ key, buffer, contentType, contentDisposition = 'inline' }) => {
    if (!isSpacesDriver()) {
        throw new AppError('Only FILESYSTEM_DRIVER=spaces is supported for CMS media uploads', 500);
    }

    ensureSpacesConfigured();

    const Upload = getUploadClass();
    const upload = new Upload({
        client: getSpacesClient(),
        params: {
            Bucket: env.storage.spaces.bucket,
            Key: key,
            Body: buffer,
            ACL: 'public-read',
            ContentType: contentType,
            ContentDisposition: contentDisposition,
        },
    });

    await upload.done();

    return {
        key,
        url: getPublicUrlForKey(key),
        content_type: contentType,
        size: buffer.length,
    };
};

const optimizeImageBuffer = async (buffer, section) => {
    const sharp = getSharp();
    const image = sharp(buffer, { failOnError: true });
    const metadata = await image.metadata();
    const maxWidth = env.storage.imageOptimizedMaxWidth;
    const width = metadata.width && metadata.width > maxWidth ? maxWidth : metadata.width;

    const optimizedBuffer = await image
        .rotate()
        .resize({ width, withoutEnlargement: true })
        .webp({ quality: 88 })
        .toBuffer();

    let thumbBuffer = null;
    if (section === 'gallery') {
        thumbBuffer = await sharp(buffer, { failOnError: true })
            .rotate()
            .resize({ width: env.storage.imageThumbnailMaxWidth, withoutEnlargement: true })
            .webp({ quality: 82 })
            .toBuffer();
    }

    return {
        metadata,
        optimizedBuffer,
        thumbBuffer,
    };
};

const createPosterFromVideoBuffer = async (videoFile, ext) => {
    let ffmpegPath = null;

    try {
        ffmpegPath = requireDependency('ffmpeg-static');
    } catch (error) {
        if (error?.details?.missing_package === 'ffmpeg-static') {
            return null;
        }

        throw error;
    }

    if (!ffmpegPath) {
        return null;
    }

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cms-video-'));
    const inputPath = path.join(tempDir, `input.${ext}`);
    const outputPath = path.join(tempDir, 'poster.jpg');

    try {
        await fs.writeFile(inputPath, videoFile.buffer);
        await execFileAsync(ffmpegPath, [
            '-y',
            '-ss', '00:00:01',
            '-i', inputPath,
            '-frames:v', '1',
            '-q:v', '2',
            outputPath,
        ]);

        return await fs.readFile(outputPath);
    } catch (_error) {
        return null;
    } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
    }
};

const uploadCmsImageAsset = async ({ file, section }) => {
    if (!IMAGE_SECTIONS.has(section)) {
        throw new AppError('Invalid image upload section', 400);
    }

    const detected = await validateImageUpload(file, env.storage.imageMaxBytes);
    const originalFilename = buildSafeFilename(file.originalname, detected.ext, `${section}-image`);
    const optimizedFilename = originalFilename.replace(/\.[^.]+$/, '.webp');
    const thumbFilename = originalFilename.replace(/\.[^.]+$/, '.webp');

    const originalKey = `${buildCmsBasePath(section, 'images/original')}/${originalFilename}`;
    const optimizedKey = `${buildCmsBasePath(section, 'images/optimized')}/${optimizedFilename}`;
    const thumbKey = section === 'gallery'
        ? `${buildCmsBasePath(section, 'images/thumbs')}/${thumbFilename}`
        : null;

    const { metadata, optimizedBuffer, thumbBuffer } = await optimizeImageBuffer(file.buffer, section);

    const [originalUpload, optimizedUpload, thumbUpload] = await Promise.all([
        uploadBufferToSpaces({
            key: originalKey,
            buffer: file.buffer,
            contentType: detected.mime,
        }),
        uploadBufferToSpaces({
            key: optimizedKey,
            buffer: optimizedBuffer,
            contentType: 'image/webp',
        }),
        thumbKey && thumbBuffer
            ? uploadBufferToSpaces({
                key: thumbKey,
                buffer: thumbBuffer,
                contentType: 'image/webp',
            })
            : Promise.resolve(null),
    ]);

    return {
        asset_type: 'IMAGE',
        section,
        storage: {
            original: originalUpload,
            optimized: optimizedUpload,
            thumbnail: thumbUpload,
        },
        cms_fields: {
            image_url: optimizedUpload.url,
            image_key: optimizedUpload.key,
            image_original_url: originalUpload.url,
            image_original_key: originalUpload.key,
            thumb_url: thumbUpload?.url || null,
            thumb_key: thumbUpload?.key || null,
            image_mime_type: detected.mime,
            image_size: file.size,
            image_width: metadata.width || null,
            image_height: metadata.height || null,
        },
    };
};

const uploadCmsVideoAsset = async ({ file, posterFile = null, section }) => {
    if (!VIDEO_SECTIONS.has(section)) {
        throw new AppError('Invalid video upload section', 400);
    }

    const detected = await validateVideoUpload(file, env.storage.videoMaxBytes);
    const videoFilename = buildSafeFilename(file.originalname, detected.ext, `${section}-video`);
    const videoKey = `${buildCmsBasePath(section, 'videos/original')}/${videoFilename}`;

    let posterBuffer = null;
    if (posterFile) {
        const sharp = getSharp();
        const posterDetected = await validateImageUpload(posterFile, env.storage.imageMaxBytes);
        const optimizedPoster = await sharp(posterFile.buffer, { failOnError: true })
            .rotate()
            .resize({ width: env.storage.imageOptimizedMaxWidth, withoutEnlargement: true })
            .webp({ quality: 88 })
            .toBuffer();
        posterBuffer = {
            buffer: optimizedPoster,
            mime: 'image/webp',
            ext: 'webp',
            originalMime: posterDetected.mime,
        };
    } else {
        const generatedPoster = await createPosterFromVideoBuffer(file, detected.ext);
        if (generatedPoster) {
            const sharp = getSharp();
            const optimizedPoster = await sharp(generatedPoster, { failOnError: true })
                .rotate()
                .resize({ width: env.storage.imageOptimizedMaxWidth, withoutEnlargement: true })
                .webp({ quality: 88 })
                .toBuffer();
            posterBuffer = {
                buffer: optimizedPoster,
                mime: 'image/webp',
                ext: 'webp',
                originalMime: 'image/jpeg',
            };
        }
    }

    const posterKey = posterBuffer
        ? `${buildCmsBasePath(section, 'videos/posters')}/${buildSafeFilename(`${path.parse(file.originalname).name}-poster`, posterBuffer.ext, `${section}-poster`)}`
        : null;

    const [videoUpload, posterUpload, posterMetadata] = await Promise.all([
        uploadBufferToSpaces({
            key: videoKey,
            buffer: file.buffer,
            contentType: detected.mime,
            contentDisposition: 'inline',
        }),
        posterKey && posterBuffer
            ? uploadBufferToSpaces({
                key: posterKey,
                buffer: posterBuffer.buffer,
                contentType: posterBuffer.mime,
            })
            : Promise.resolve(null),
        posterBuffer ? getSharp()(posterBuffer.buffer).metadata() : Promise.resolve(null),
    ]);

    return {
        asset_type: 'VIDEO',
        section,
        storage: {
            video: videoUpload,
            poster: posterUpload,
        },
        cms_fields: {
            image_url: posterUpload?.url || null,
            image_key: posterUpload?.key || null,
            poster_url: posterUpload?.url || null,
            poster_key: posterUpload?.key || null,
            video_url: videoUpload.url,
            video_key: videoUpload.key,
            file_mime_type: detected.mime,
            file_size: file.size,
            image_width: posterMetadata?.width || null,
            image_height: posterMetadata?.height || null,
            video_duration_sec: null,
        },
    };
};

module.exports = {
    CMS_STORAGE_ROOT,
    buildCmsBasePath,
    uploadBufferToSpaces,
    getPublicUrlForKey,
    uploadCmsImageAsset,
    uploadCmsVideoAsset,
};
