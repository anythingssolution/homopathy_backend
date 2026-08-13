const fs = require('fs/promises');
const path = require('path');
const AppError = require('../../utils/AppError');
const asyncHandler = require('../../utils/asyncHandler');

const logsDirectory = path.join(__dirname, '..', '..', 'logs');
const logFilePattern = /^error-(\d{4}-\d{2}-\d{2})\.log$/;
const maxPreviewBytes = 250000;

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
    let entries;

    try {
        entries = await fs.readdir(logsDirectory);
    } catch (error) {
        if (error?.code === 'ENOENT') {
            return [];
        }
        throw error;
    }
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
    const stats = await fs.stat(filePath);
    const previewBytes = Math.min(stats.size, maxPreviewBytes);
    const fileHandle = await fs.open(filePath, 'r');
    const fileBuffer = Buffer.alloc(previewBytes);

    try {
        await fileHandle.read(fileBuffer, 0, previewBytes, Math.max(stats.size - previewBytes, 0));
    } finally {
        await fileHandle.close();
    }

    const content = fileBuffer.toString('utf8');

    return {
        file_name: safeFileName,
        content,
        preview_truncated: stats.size > maxPreviewBytes,
        preview_content: content,
    };
};

const getSystemLogsOverview = asyncHandler(async (_req, res) => {
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
