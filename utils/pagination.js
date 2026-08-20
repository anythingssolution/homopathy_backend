const toPositiveInt = (value) => {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) {
        return null;
    }

    return parsed;
};

const parsePagination = (raw = {}, { defaultPageSize = 8, maxPageSize = 100 } = {}) => {
    const page = toPositiveInt(raw.page) || 1;
    const requestedPageSize = toPositiveInt(raw.page_size) || toPositiveInt(raw.limit) || defaultPageSize;
    const pageSize = Math.min(Math.max(1, requestedPageSize), maxPageSize);

    return { page, pageSize };
};

const resolvePagination = ({ page = 1, pageSize = 8, total = 0 } = {}) => {
    const safePageSize = Math.max(1, Number(pageSize) || 8);
    const safeTotal = Math.max(0, Number(total) || 0);
    const totalPages = Math.max(1, Math.ceil(safeTotal / safePageSize) || 1);
    const currentPage = Math.min(Math.max(1, Number(page) || 1), totalPages);

    return {
        page: currentPage,
        pageSize: safePageSize,
        offset: (currentPage - 1) * safePageSize,
        total: safeTotal,
        totalPages,
    };
};

const buildPaginationMeta = ({ page, pageSize, total, totalPages, filters = {}, extra = {} } = {}) => ({
    page,
    page_size: pageSize,
    total: Number(total) || 0,
    total_pages: totalPages || Math.max(1, Math.ceil((Number(total) || 0) / (pageSize || 8))),
    ...extra,
    ...(Object.keys(filters).length > 0 ? { filters } : {}),
});

module.exports = {
    parsePagination,
    resolvePagination,
    buildPaginationMeta,
};
