const fs = require('fs/promises');
const path = require('path');
const { env } = require('../../config/env');
const AppError = require('../../utils/AppError');
const asyncHandler = require('../../utils/asyncHandler');

const logsDirectory = path.join(__dirname, '..', '..', 'logs');
const logFilePattern = /^error-(\d{4}-\d{2}-\d{2})\.log$/;
const maxPreviewBytes = 250000;
const staticLogsViewerPassword = 'vectre@logs';

const ensureDevAccess = (req) => {
    if (env.nodeEnv === 'production') {
        throw new AppError('System logs viewer is available only outside production', 403);
    }

    const providedPassword = String(req.headers['x-log-viewer-password'] || '');
    if (providedPassword !== staticLogsViewerPassword) {
        throw new AppError('Invalid logs viewer password', 401);
    }
};

const parseLogFileMeta = async (fileName) => {
    const filePath = path.join(logsDirectory, fileName);
    const stats = await fs.stat(filePath);
    const match = fileName.match(logFilePattern);

    return {
        file_name: fileName,
        file_path: filePath,
        date_key: match ? match[1] : null,
        modified_at: stats.mtime.toISOString(),
        size_bytes: stats.size,
    };
};

const listRecentLogFiles = async (days = 10) => {
    const entries = await fs.readdir(logsDirectory);
    const now = new Date();
    const cutoff = new Date(now);
    cutoff.setDate(cutoff.getDate() - Math.max(days - 1, 0));
    cutoff.setHours(0, 0, 0, 0);

    const matchingFiles = entries.filter((entry) => logFilePattern.test(entry));
    const metadata = await Promise.all(matchingFiles.map(parseLogFileMeta));

    return metadata
        .filter((file) => file.date_key && new Date(`${file.date_key}T00:00:00`).getTime() >= cutoff.getTime())
        .sort((left, right) => {
            const leftTime = new Date(`${left.date_key}T00:00:00`).getTime();
            const rightTime = new Date(`${right.date_key}T00:00:00`).getTime();
            return rightTime - leftTime;
        });
};

const readLogFilePreview = async (fileName) => {
    const safeFileName = path.basename(fileName);
    if (!logFilePattern.test(safeFileName)) {
        throw new AppError('Invalid log file name', 400);
    }

    const filePath = path.join(logsDirectory, safeFileName);
    const fileBuffer = await fs.readFile(filePath);
    const content = fileBuffer.toString('utf8');

    return {
        file_name: safeFileName,
        content,
        preview_truncated: fileBuffer.length > maxPreviewBytes,
        preview_content: content.slice(-maxPreviewBytes),
    };
};

const getSystemLogsOverview = asyncHandler(async (_req, res) => {
    ensureDevAccess(_req);

    const files = await listRecentLogFiles(10);
    const latestFile = files[0] || null;
    const latestPreview = latestFile ? await readLogFilePreview(latestFile.file_name) : null;

    return res.status(200).json({
        success: true,
        message: 'Recent system logs fetched',
        data: {
            logs_directory: logsDirectory,
            days_covered: 10,
            files,
            latest_file: latestFile,
            latest_preview: latestPreview,
        },
    });
});

const getSystemLogFile = asyncHandler(async (req, res) => {
    ensureDevAccess(req);

    const { fileName } = req.params;
    const filePreview = await readLogFilePreview(fileName);
    const fileMeta = await parseLogFileMeta(filePreview.file_name);

    return res.status(200).json({
        success: true,
        message: 'System log file fetched',
        data: {
            ...fileMeta,
            ...filePreview,
        },
    });
});

module.exports = {
    getSystemLogsOverview,
    getSystemLogFile,
};
