const path = require('path');

const slugifyBasename = (value) => String(value || '')
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .toLowerCase();

const hasDoubleExtension = (originalName) => {
    const parts = String(originalName || '')
        .split('/')
        .pop()
        .split('.')
        .filter(Boolean);

    return parts.length > 2;
};

const buildSafeFilename = (originalName, extension, fallbackPrefix = 'file') => {
    const baseName = path.parse(String(originalName || '')).name;
    const safeBaseName = slugifyBasename(baseName) || fallbackPrefix;
    const safeExtension = String(extension || '').trim().toLowerCase().replace(/^\.+/, '');
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    return `${stamp}-${safeBaseName}.${safeExtension}`;
};

module.exports = {
    slugifyBasename,
    hasDoubleExtension,
    buildSafeFilename,
};
