const ExcelJS = require('exceljs');
const { withTransaction, query } = require('../config/db');

const SOURCE_TYPES = new Set(['REGULAR_PRODUCT', 'RADIENT_PHARMA', 'MEDICAL_PRODUCT_PRICE']);

const TEMPLATE_COLUMNS = [
    { header: 'medicine_value', key: 'medicine_value', width: 28 },
    { header: 'source_type', key: 'source_type', width: 24 },
    { header: 'product_name', key: 'product_name', width: 32 },
    { header: 'product_type', key: 'product_type', width: 18 },
    { header: 'category', key: 'category', width: 20 },
    { header: 'packing', key: 'packing', width: 18 },
    { header: 'size_or_weight', key: 'size_or_weight', width: 18 },
    { header: 'mrp_rate', key: 'mrp_rate', width: 14 },
    { header: 'price_min', key: 'price_min', width: 14 },
    { header: 'price_max', key: 'price_max', width: 14 },
    { header: 'shipper_size_pcs', key: 'shipper_size_pcs', width: 18 },
    { header: 'description', key: 'description', width: 40 },
    { header: 'formula_composition', key: 'formula_composition', width: 45 },
    { header: 'is_active', key: 'is_active', width: 12 },
];

const SAMPLE_ROWS = [
    {
        medicine_value: 'Alfa Compound Syrup',
        source_type: 'REGULAR_PRODUCT',
        product_name: 'Alfa Compound Syrup',
        product_type: 'SYRUP',
        packing: '100 ML',
        mrp_rate: 115,
        is_active: 1,
    },
    {
        medicine_value: 'Acid Chryso Ointment',
        source_type: 'RADIENT_PHARMA',
        product_name: 'Acid Chryso Ointment',
        category: 'OINTMENT',
        size_or_weight: '25gm',
        mrp_rate: 150,
        shipper_size_pcs: 48,
        description: 'Sample description',
        formula_composition: 'Sample formula',
        is_active: 1,
    },
    {
        medicine_value: 'Ad. A-108',
        source_type: 'MEDICAL_PRODUCT_PRICE',
        product_name: 'Ad. A-108',
        category: 'Adven',
        price_min: 200,
        price_max: 200,
        is_active: 1,
    },
];

const normalizeValue = (value) => String(value || '').trim().toLowerCase();

const normalizeOptionalString = (value) => {
    const normalized = String(value ?? '').trim();
    return normalized || null;
};

const parseDecimal = (value, fieldName, rowNumber, errors) => {
    if (value === undefined || value === null || String(value).trim() === '') {
        return null;
    }

    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) {
        errors.push({
            row_number: rowNumber,
            field: fieldName,
            reason: `${fieldName} must be a valid non-negative number`,
        });
        return null;
    }

    return Number(parsed.toFixed(2));
};

const parseInteger = (value, fieldName, rowNumber, errors) => {
    if (value === undefined || value === null || String(value).trim() === '') {
        return null;
    }

    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 0) {
        errors.push({
            row_number: rowNumber,
            field: fieldName,
            reason: `${fieldName} must be a valid non-negative integer`,
        });
        return null;
    }

    return parsed;
};

const parseIsActive = (value) => {
    if (value === undefined || value === null || String(value).trim() === '') {
        return 1;
    }

    const normalized = String(value).trim().toLowerCase();
    return ['0', 'false', 'no', 'inactive'].includes(normalized) ? 0 : 1;
};

const getCellText = (cell) => {
    if (cell.value === null || cell.value === undefined) {
        return '';
    }

    if (typeof cell.value === 'object') {
        return String(cell.text || '').trim();
    }

    return String(cell.value).trim();
};

const createMedicalProductTemplateWorkbook = async () => {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Dr Trivedi Homeopathy';
    workbook.created = new Date();

    const sheet = workbook.addWorksheet('medical_products');
    sheet.columns = TEMPLATE_COLUMNS;
    sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    sheet.getRow(1).fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FF549E9E' },
    };

    SAMPLE_ROWS.forEach((row) => sheet.addRow(row));
    sheet.views = [{ state: 'frozen', ySplit: 1 }];

    const sourceTypeColumn = sheet.getColumn('source_type');
    for (let rowNumber = 2; rowNumber <= 500; rowNumber += 1) {
        sheet.getCell(rowNumber, sourceTypeColumn.number).dataValidation = {
            type: 'list',
            allowBlank: false,
            formulae: ['"REGULAR_PRODUCT,RADIENT_PHARMA,MEDICAL_PRODUCT_PRICE"'],
        };
    }

    return workbook.xlsx.writeBuffer();
};

const readMedicalProductsSheet = async (buffer) => {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
    return workbook.getWorksheet('medical_products') || workbook.worksheets[0] || null;
};

const getHeaderMap = (sheet) => {
    const headerMap = new Map();
    sheet.getRow(1).eachCell((cell, columnNumber) => {
        const header = getCellText(cell).toLowerCase();
        if (header) {
            headerMap.set(header, columnNumber);
        }
    });
    return headerMap;
};

const getRowValue = (row, headerMap, key) => {
    const columnNumber = headerMap.get(key);
    if (!columnNumber) {
        return '';
    }

    return getCellText(row.getCell(columnNumber));
};

const buildDedupeKey = (sourceType, row) => {
    if (sourceType === 'REGULAR_PRODUCT') {
        return [
            row.normalized_product_name,
            normalizeValue(row.packing),
            normalizeValue(row.product_type),
        ].join('|');
    }

    if (sourceType === 'RADIENT_PHARMA') {
        return [
            row.normalized_product_name,
            normalizeValue(row.size_or_weight),
            normalizeValue(row.category),
        ].join('|');
    }

    return [
        normalizeValue(row.category),
        row.normalized_product_name,
    ].join('|');
};

const parseImportRows = (sheet) => {
    const headerMap = getHeaderMap(sheet);
    const missingHeaders = TEMPLATE_COLUMNS
        .map((column) => column.key)
        .filter((key) => !headerMap.has(key));

    if (missingHeaders.length > 0) {
        return {
            rows: [],
            skippedRows: missingHeaders.map((header) => ({
                row_number: 1,
                product_name: null,
                reason: `Missing required column: ${header}`,
            })),
        };
    }

    const parsedRows = [];
    const skippedRows = [];
    const currentImportProductNames = new Map();

    sheet.eachRow((row, rowNumber) => {
        if (rowNumber === 1) {
            return;
        }

        const raw = {};
        TEMPLATE_COLUMNS.forEach((column) => {
            raw[column.key] = getRowValue(row, headerMap, column.key);
        });

        const hasAnyValue = Object.values(raw).some((value) => String(value || '').trim() !== '');
        if (!hasAnyValue) {
            return;
        }

        const rowErrors = [];
        const medicineValue = normalizeOptionalString(raw.medicine_value);
        const sourceType = String(raw.source_type || '').trim().toUpperCase();
        const productName = normalizeOptionalString(raw.product_name);
        const normalizedProductName = normalizeValue(productName);

        if (!medicineValue) {
            rowErrors.push({ row_number: rowNumber, field: 'medicine_value', reason: 'medicine_value is required' });
        }

        if (!SOURCE_TYPES.has(sourceType)) {
            rowErrors.push({ row_number: rowNumber, field: 'source_type', reason: 'source_type must be REGULAR_PRODUCT, RADIENT_PHARMA or MEDICAL_PRODUCT_PRICE' });
        }

        if (!productName) {
            rowErrors.push({ row_number: rowNumber, field: 'product_name', reason: 'product_name is required' });
        }

        const rowPayload = {
            row_number: rowNumber,
            medicine_value: medicineValue,
            normalized_medicine_value: normalizeValue(medicineValue),
            source_type: sourceType,
            product_name: productName,
            product_type: normalizeOptionalString(raw.product_type),
            category: normalizeOptionalString(raw.category),
            packing: normalizeOptionalString(raw.packing),
            size_or_weight: normalizeOptionalString(raw.size_or_weight),
            mrp_rate: parseDecimal(raw.mrp_rate, 'mrp_rate', rowNumber, rowErrors),
            price_min: parseDecimal(raw.price_min, 'price_min', rowNumber, rowErrors),
            price_max: parseDecimal(raw.price_max, 'price_max', rowNumber, rowErrors),
            shipper_size_pcs: parseInteger(raw.shipper_size_pcs, 'shipper_size_pcs', rowNumber, rowErrors),
            description: normalizeOptionalString(raw.description),
            formula_composition: normalizeOptionalString(raw.formula_composition),
            normalized_category: normalizeValue(raw.category),
            normalized_product_name: normalizedProductName,
            is_active: parseIsActive(raw.is_active),
        };

        if (rowErrors.length > 0) {
            rowErrors.forEach((error) => {
                skippedRows.push({
                    row_number: rowNumber,
                    product_name: productName,
                    reason: error.reason,
                });
            });
            return;
        }

        if (currentImportProductNames.has(normalizedProductName)) {
            skippedRows.push({
                row_number: rowNumber,
                product_name: productName,
                reason: `Duplicate product_name in current import; already present at row ${currentImportProductNames.get(normalizedProductName)}`,
            });
            return;
        }

        currentImportProductNames.set(normalizedProductName, rowNumber);
        rowPayload.dedupe_key = buildDedupeKey(sourceType, rowPayload);
        parsedRows.push(rowPayload);
    });

    return {
        rows: parsedRows,
        skippedRows,
    };
};

const getExistingProductNames = async (normalizedProductNames) => {
    if (normalizedProductNames.length === 0) {
        return new Map();
    }

    const placeholders = normalizedProductNames.map(() => '?').join(', ');
    const rows = await query(
        `SELECT id, product_name, normalized_product_name
         FROM master_medical_products
         WHERE normalized_product_name IN (${placeholders})`,
        normalizedProductNames
    );

    return new Map(rows.map((row) => [row.normalized_product_name, row]));
};

const upsertMedicineMaster = async (connection, row) => {
    const [result] = await connection.execute(
        `INSERT INTO master_text_medicines
         (medicine_value, normalized_value, is_active)
         VALUES (?, ?, 1)
         ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id), updated_at = CURRENT_TIMESTAMP`,
        [row.medicine_value, row.normalized_medicine_value]
    );

    return result.insertId;
};

const importMedicalProductsFromWorkbook = async (buffer) => {
    const sheet = await readMedicalProductsSheet(buffer);
    if (!sheet) {
        return {
            inserted_medicines: 0,
            inserted_products: 0,
            skipped_rows: [{
                row_number: 0,
                product_name: null,
                reason: 'No worksheet found in uploaded Excel file',
            }],
        };
    }

    const parsed = parseImportRows(sheet);
    const existingProducts = await getExistingProductNames([
        ...new Set(parsed.rows.map((row) => row.normalized_product_name)),
    ]);

    const insertableRows = [];
    const skippedRows = [...parsed.skippedRows];

    parsed.rows.forEach((row) => {
        const existingProduct = existingProducts.get(row.normalized_product_name);
        if (existingProduct) {
            skippedRows.push({
                row_number: row.row_number,
                product_name: row.product_name,
                reason: `Product name already exists in master_medical_products as "${existingProduct.product_name}"`,
            });
            return;
        }

        insertableRows.push(row);
    });

    const insertedMedicineIds = new Set();
    let insertedProducts = 0;

    await withTransaction(async (connection) => {
        for (const row of insertableRows) {
            const medicineTextId = await upsertMedicineMaster(connection, row);
            insertedMedicineIds.add(medicineTextId);

            await connection.execute(
                `INSERT INTO master_medical_products
                 (medicine_text_id, source_type, product_name, product_type, category,
                  packing, size_or_weight, mrp_rate, price_min, price_max, shipper_size_pcs,
                  description, formula_composition, normalized_category,
                  normalized_product_name, dedupe_key, is_active)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    medicineTextId,
                    row.source_type,
                    row.product_name,
                    row.product_type,
                    row.category,
                    row.packing,
                    row.size_or_weight,
                    row.mrp_rate,
                    row.price_min,
                    row.price_max,
                    row.shipper_size_pcs,
                    row.description,
                    row.formula_composition,
                    row.normalized_category,
                    row.normalized_product_name,
                    row.dedupe_key,
                    row.is_active,
                ]
            );

            insertedProducts += 1;
        }
    });

    return {
        inserted_medicines: insertedMedicineIds.size,
        inserted_products: insertedProducts,
        skipped_rows: skippedRows.sort((a, b) => a.row_number - b.row_number),
    };
};

module.exports = {
    createMedicalProductTemplateWorkbook,
    importMedicalProductsFromWorkbook,
};
