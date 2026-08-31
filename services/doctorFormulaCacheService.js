const { query, withTransaction } = require('../config/db');
const AppError = require('../utils/AppError');
const { emitToUser } = require('../utils/realtime');

const formulaSnapshotCache = new Map();

const RULE_KEYS = {
    plainNumber: 'PLAIN_NUMBER',
    slashSingleNumeric: 'SLASH_SINGLE_NUMERIC',
    slashDoubleNumeric: 'SLASH_DOUBLE_NUMERIC',
    slashPriceNumeric: 'SLASH_PRICE_NUMERIC',
};

const DEFAULT_TEMPLATE_DEFINITIONS = [
    {
        template_code: 'DEFAULT_444',
        template_name: 'Default 4-4-4',
        is_default: true,
        rows: [
            { dose_label: 'MORNING', sort_order: 1, times_per_day: 1, balls_per_dose: 4, instructions: '' },
            { dose_label: 'AFTERNOON', sort_order: 2, times_per_day: 1, balls_per_dose: 4, instructions: '' },
            { dose_label: 'NIGHT', sort_order: 3, times_per_day: 1, balls_per_dose: 4, instructions: '' },
        ],
    },
    {
        template_code: 'BD',
        template_name: 'Twice Daily',
        rows: [
            { dose_label: 'MORNING', sort_order: 1, times_per_day: 1, balls_per_dose: 4, instructions: '' },
            { dose_label: 'NIGHT', sort_order: 2, times_per_day: 1, balls_per_dose: 4, instructions: '' },
        ],
    },
    {
        template_code: 'TDS',
        template_name: 'Three Times Daily',
        rows: [
            { dose_label: 'MORNING', sort_order: 1, times_per_day: 1, balls_per_dose: 4, instructions: '' },
            { dose_label: 'AFTERNOON', sort_order: 2, times_per_day: 1, balls_per_dose: 4, instructions: '' },
            { dose_label: 'NIGHT', sort_order: 3, times_per_day: 1, balls_per_dose: 4, instructions: '' },
        ],
    },
    {
        template_code: 'HS',
        template_name: 'Night Only',
        rows: [
            { dose_label: 'NIGHT', sort_order: 1, times_per_day: 1, balls_per_dose: 4, instructions: '' },
        ],
    },
    {
        template_code: 'OD',
        template_name: 'Morning Only',
        rows: [
            { dose_label: 'MORNING', sort_order: 1, times_per_day: 1, balls_per_dose: 4, instructions: '' },
        ],
    },
];

const DEFAULT_RULE_DEFINITIONS = {
    plain_number: {
        rule_key: RULE_KEYS.plainNumber,
        amount_strategy: 'FIXED',
        fixed_amount: 80,
        multiplier_value: null,
        template_code: 'DEFAULT_444',
    },
    slash_single_numeric: {
        rule_key: RULE_KEYS.slashSingleNumeric,
        amount_strategy: 'MULTIPLY_SUFFIX',
        fixed_amount: null,
        multiplier_value: 100,
        template_code: 'DEFAULT_444',
    },
    slash_double_numeric: {
        rule_key: RULE_KEYS.slashDoubleNumeric,
        amount_strategy: 'MULTIPLY_SUFFIX',
        fixed_amount: null,
        multiplier_value: 10,
        template_code: 'DEFAULT_444',
    },
    slash_price_numeric: {
        rule_key: RULE_KEYS.slashPriceNumeric,
        amount_strategy: 'SUFFIX_AS_PRICE',
        fixed_amount: null,
        multiplier_value: null,
        template_code: 'DEFAULT_444',
    },
};

const DEFAULT_ALPHA_CODE_DEFINITIONS = [
    {
        code: 'BD',
        description: 'Twice daily',
        fixed_amount: 80,
        template_code: 'BD',
        duration_override_days: null,
        is_active: true,
    },
    {
        code: 'TDS',
        description: 'Three times daily',
        fixed_amount: 80,
        template_code: 'TDS',
        duration_override_days: null,
        is_active: true,
    },
    {
        code: 'HS',
        description: 'Night dose',
        fixed_amount: 80,
        template_code: 'HS',
        duration_override_days: null,
        is_active: true,
    },
    {
        code: 'OD',
        description: 'Once daily',
        fixed_amount: 80,
        template_code: 'OD',
        duration_override_days: null,
        is_active: true,
    },
];

const NUMERIC_MEDICINE_MIN = 1;
const NUMERIC_MEDICINE_MAX = 200;
const NUMERIC_MEDICINE_TOKEN_RE = /^(\d{1,3})(?:\[(\d{1,4}(?:\s*,\s*\d{1,4})*)\])?([A-Za-z]*)(?:\/([A-Za-z0-9]+))?$/;

const createValidationError = (message) => new AppError(message, 400);

const toPositiveInt = (value) => {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) {
        return null;
    }

    return parsed;
};

const toNonNegativeAmount = (value) => {
    if (value === null || value === undefined || value === '') {
        return null;
    }

    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) {
        return null;
    }

    return Number(parsed.toFixed(2));
};

const safeJsonStringify = (value) => {
    try {
        return JSON.stringify(value ?? null);
    } catch (_error) {
        return JSON.stringify(null);
    }
};

const cloneDeep = (value) => JSON.parse(JSON.stringify(value));

const normalizeNumericMedicinePower = (power) => {
    if (!power) {
        return null;
    }

    const parts = String(power)
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean)
        .map((part) => {
            const parsed = Number(part);
            return Number.isInteger(parsed) ? String(parsed) : null;
        });

    if (parts.length === 0 || parts.some((part) => part == null)) {
        return null;
    }

    return parts.join(',');
};

const splitQuickFormulaCommaItems = (source) => {
    const items = [];
    let current = '';
    let bracketDepth = 0;

    for (const ch of String(source || '')) {
        if (ch === '[') {
            bracketDepth += 1;
        } else if (ch === ']') {
            bracketDepth = Math.max(0, bracketDepth - 1);
        }

        if (ch === ',' && bracketDepth === 0) {
            const trimmed = current.trim();
            if (trimmed) {
                items.push(trimmed);
            }
            current = '';
            continue;
        }

        current += ch;
    }

    const trimmed = current.trim();
    if (trimmed) {
        items.push(trimmed);
    }

    return items;
};

const buildDefaultPayload = () => ({
    set_name: 'Default Quick Formula',
    description: 'Default numeric consultation quick-entry rules',
    is_default: true,
    is_active: true,
    is_published: true,
    rules: cloneDeep(DEFAULT_RULE_DEFINITIONS),
    templates: cloneDeep(DEFAULT_TEMPLATE_DEFINITIONS),
    alpha_codes: cloneDeep(DEFAULT_ALPHA_CODE_DEFINITIONS),
});

const normalizeTemplateRows = (rows = [], fallbackLabelPrefix = 'DOSE') => rows.map((row, index) => {
    const doseLabel = String(row?.dose_label || `${fallbackLabelPrefix}_${index + 1}`).trim().toUpperCase();
    const sortOrder = toPositiveInt(row?.sort_order) || (index + 1);
    const timesPerDay = toPositiveInt(row?.times_per_day) || 1;
    const ballsPerDose = toPositiveInt(row?.balls_per_dose);
    if (!ballsPerDose) {
        throw createValidationError('Each dosage row must have positive balls per dose');
    }

    return {
        dose_label: doseLabel,
        sort_order: sortOrder,
        times_per_day: timesPerDay,
        balls_per_dose: ballsPerDose,
        instructions: row?.instructions ? String(row.instructions).trim() : '',
    };
});

const normalizeFormulaPayload = (payload = {}) => {
    const setName = String(payload?.set_name || '').trim();
    if (!setName) {
        throw createValidationError('Formula set name is required');
    }

    const description = payload?.description ? String(payload.description).trim() : null;
    const isDefault = payload?.is_default === true || payload?.is_default === 1;
    const isActive = payload?.is_active !== false;
    const isPublished = payload?.is_published !== false;

    const templatesInput = Array.isArray(payload?.templates) ? payload.templates : [];
    if (templatesInput.length === 0) {
        throw createValidationError('At least one dosage template is required');
    }

    const seenTemplateCodes = new Set();
    const templates = templatesInput.map((template, index) => {
        const templateCode = String(template?.template_code || '').trim().toUpperCase();
        const templateName = String(template?.template_name || '').trim();
        if (!templateCode) {
            throw createValidationError(`templates[${index}].template_code is required`);
        }
        if (!templateName) {
            throw createValidationError(`templates[${index}].template_name is required`);
        }
        if (seenTemplateCodes.has(templateCode)) {
            throw createValidationError(`Duplicate template code: ${templateCode}`);
        }
        seenTemplateCodes.add(templateCode);

        const rows = normalizeTemplateRows(Array.isArray(template?.rows) ? template.rows : []);
        if (rows.length === 0) {
            throw createValidationError(`Template ${templateCode} must have at least one dosage row`);
        }

        return {
            template_code: templateCode,
            template_name: templateName,
            is_default: template?.is_default === true || template?.is_default === 1,
            is_active: template?.is_active !== false,
            rows,
        };
    });

    const rulesInput = payload?.rules && typeof payload.rules === 'object'
        ? payload.rules
        : null;
    if (!rulesInput) {
        throw createValidationError('rules object is required');
    }

    const normalizeRule = (input, label) => {
        const amountStrategy = String(input?.amount_strategy || '').trim().toUpperCase();
        if (!['FIXED', 'MULTIPLY_SUFFIX', 'SUFFIX_AS_PRICE'].includes(amountStrategy)) {
            throw createValidationError(`${label} amount_strategy must be FIXED, MULTIPLY_SUFFIX, or SUFFIX_AS_PRICE`);
        }

        const templateCode = String(input?.template_code || '').trim().toUpperCase();
        if (!templateCode || !seenTemplateCodes.has(templateCode)) {
            throw createValidationError(`${label} template_code must reference a valid dosage template`);
        }

        const fixedAmount = toNonNegativeAmount(input?.fixed_amount);
        const multiplierValue = toNonNegativeAmount(input?.multiplier_value);

        if (amountStrategy === 'FIXED' && fixedAmount === null) {
            throw createValidationError(`${label} fixed_amount is required for FIXED strategy`);
        }

        if (amountStrategy === 'MULTIPLY_SUFFIX' && multiplierValue === null) {
            throw createValidationError(`${label} multiplier_value is required for MULTIPLY_SUFFIX strategy`);
        }

        if (amountStrategy === 'SUFFIX_AS_PRICE' && (fixedAmount !== null || multiplierValue !== null)) {
            throw createValidationError(`${label} fixed_amount and multiplier_value must be empty for SUFFIX_AS_PRICE strategy`);
        }

        return {
            amount_strategy: amountStrategy,
            fixed_amount: fixedAmount,
            multiplier_value: multiplierValue,
            template_code: templateCode,
            is_active: input?.is_active !== false,
        };
    };

    const rules = {
        plain_number: normalizeRule(rulesInput.plain_number, 'plain_number'),
        slash_single_numeric: normalizeRule(rulesInput.slash_single_numeric, 'slash_single_numeric'),
        slash_double_numeric: normalizeRule(rulesInput.slash_double_numeric, 'slash_double_numeric'),
        slash_price_numeric: normalizeRule(rulesInput.slash_price_numeric, 'slash_price_numeric'),
    };

    const alphaCodesInput = Array.isArray(payload?.alpha_codes) ? payload.alpha_codes : [];
    const seenAlphaCodes = new Set();
    const alphaCodes = alphaCodesInput.map((code, index) => {
        const alphaCode = String(code?.code || '').trim().toUpperCase();
        if (!alphaCode || !/^[A-Z]+$/.test(alphaCode)) {
            throw createValidationError(`alpha_codes[${index}].code must contain only letters`);
        }
        if (seenAlphaCodes.has(alphaCode)) {
            throw createValidationError(`Duplicate alpha code: ${alphaCode}`);
        }
        seenAlphaCodes.add(alphaCode);

        const templateCode = String(code?.template_code || '').trim().toUpperCase();
        if (!templateCode || !seenTemplateCodes.has(templateCode)) {
            throw createValidationError(`alpha_codes[${index}].template_code must reference a valid dosage template`);
        }

        const fixedAmount = code?.fixed_amount === '' || code?.fixed_amount === null || code?.fixed_amount === undefined
            ? null
            : toNonNegativeAmount(code.fixed_amount);
        if (code?.fixed_amount !== '' && code?.fixed_amount !== null && code?.fixed_amount !== undefined && fixedAmount === null) {
            throw createValidationError(`alpha_codes[${index}].fixed_amount must be a valid non-negative number`);
        }

        return {
            code: alphaCode,
            description: code?.description ? String(code.description).trim() : null,
            fixed_amount: fixedAmount,
            template_code: templateCode,
            duration_override_days: toPositiveInt(code?.duration_override_days),
            is_active: code?.is_active !== false,
        };
    });

    return {
        set_name: setName,
        description,
        is_default: isDefault,
        is_active: isActive,
        is_published: isPublished,
        templates,
        rules,
        alpha_codes: alphaCodes,
    };
};

const insertFormulaSetAuditLog = async (connection, {
    doctorId,
    formulaSetId,
    actionType,
    entityType,
    entityId = null,
    beforeValue = null,
    afterValue = null,
}) => {
    await connection.execute(
        `INSERT INTO doctor_numeric_formula_audit_logs
         (doctor_id, formula_set_id, action_type, entity_type, entity_id, before_json, after_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
            doctorId,
            formulaSetId,
            actionType,
            entityType,
            entityId,
            safeJsonStringify(beforeValue),
            safeJsonStringify(afterValue),
        ]
    );
};

const getFormulaSetSummaries = async ({ doctorId }) => query(
    `SELECT
        s.id,
        s.doctor_id,
        s.set_name,
        s.description,
        s.is_default,
        s.is_active,
        s.is_published,
        s.version_no,
        s.published_at,
        s.created_at,
        s.updated_at,
        (SELECT COUNT(*) FROM doctor_numeric_formula_templates t WHERE t.formula_set_id = s.id) AS total_templates,
        (SELECT COUNT(*) FROM doctor_numeric_formula_alpha_codes a WHERE a.formula_set_id = s.id) AS total_alpha_codes
     FROM doctor_numeric_formula_sets s
     WHERE s.doctor_id = ?
     ORDER BY s.is_active DESC, s.updated_at DESC, s.id DESC`,
    [doctorId]
);

const getFormulaSetDetail = async ({ doctorId, setId }) => {
    const setRows = await query(
        `SELECT
            id,
            doctor_id,
            set_name,
            description,
            is_default,
            is_active,
            is_published,
            version_no,
            published_at,
            created_at,
            updated_at
         FROM doctor_numeric_formula_sets
         WHERE id = ?
           AND doctor_id = ?
         LIMIT 1`,
        [setId, doctorId]
    );

    if (setRows.length === 0) {
        return null;
    }

    const [ruleRows, templateRows, templateDoseRows, alphaCodeRows] = await Promise.all([
        query(
            `SELECT
                id,
                formula_set_id,
                rule_key,
                amount_strategy,
                fixed_amount,
                multiplier_value,
                template_id,
                is_active,
                created_at,
                updated_at
             FROM doctor_numeric_formula_rules
             WHERE formula_set_id = ?
             ORDER BY id ASC`,
            [setId]
        ),
        query(
            `SELECT
                id,
                formula_set_id,
                template_code,
                template_name,
                is_default,
                is_active,
                created_at,
                updated_at
             FROM doctor_numeric_formula_templates
             WHERE formula_set_id = ?
             ORDER BY is_default DESC, template_code ASC, id ASC`,
            [setId]
        ),
        query(
            `SELECT
                id,
                template_id,
                dose_label,
                sort_order,
                times_per_day,
                balls_per_dose,
                instructions,
                is_active,
                created_at,
                updated_at
             FROM doctor_numeric_formula_template_rows
             WHERE template_id IN (
                SELECT id
                FROM doctor_numeric_formula_templates
                WHERE formula_set_id = ?
             )
             ORDER BY template_id ASC, sort_order ASC, id ASC`,
            [setId]
        ),
        query(
            `SELECT
                id,
                formula_set_id,
                code,
                description,
                fixed_amount,
                template_id,
                duration_override_days,
                is_active,
                created_at,
                updated_at
             FROM doctor_numeric_formula_alpha_codes
             WHERE formula_set_id = ?
             ORDER BY code ASC, id ASC`,
            [setId]
        ),
    ]);

    const templateIdToCode = new Map(templateRows.map((row) => [Number(row.id), row.template_code]));
    const rowsByTemplateId = templateDoseRows.reduce((acc, row) => {
        const key = Number(row.template_id);
        if (!acc.has(key)) {
            acc.set(key, []);
        }
        acc.get(key).push(row);
        return acc;
    }, new Map());

    const templates = templateRows.map((row) => ({
        ...row,
        template_code: String(row.template_code || '').toUpperCase(),
        rows: (rowsByTemplateId.get(Number(row.id)) || []).map((dose) => ({
            ...dose,
            dose_label: String(dose.dose_label || '').toUpperCase(),
        })),
    }));

    const findRule = (ruleKey) => {
        const row = ruleRows.find((item) => item.rule_key === ruleKey) || null;
        if (!row) {
            return null;
        }

        return {
            ...row,
            template_code: row.template_id ? templateIdToCode.get(Number(row.template_id)) || null : null,
        };
    };

    const rules = {
        plain_number: findRule(RULE_KEYS.plainNumber),
        slash_single_numeric: findRule(RULE_KEYS.slashSingleNumeric),
        slash_double_numeric: findRule(RULE_KEYS.slashDoubleNumeric),
        slash_price_numeric: findRule(RULE_KEYS.slashPriceNumeric),
    };

    const alpha_codes = alphaCodeRows.map((row) => ({
        ...row,
        code: String(row.code || '').toUpperCase(),
        template_code: row.template_id ? templateIdToCode.get(Number(row.template_id)) || null : null,
    }));

    return {
        ...setRows[0],
        templates,
        rules,
        alpha_codes,
    };
};

const buildFormulaSnapshotFromDetail = (detail) => {
    if (!detail) {
        return null;
    }

    const templatesByCode = new Map(
        (detail.templates || []).map((template) => [
            String(template.template_code || '').toUpperCase(),
            {
                template_code: String(template.template_code || '').toUpperCase(),
                template_name: template.template_name,
                rows: (template.rows || []).map((row) => ({
                    dose_label: String(row.dose_label || '').toUpperCase(),
                    sort_order: Number(row.sort_order) || 1,
                    times_per_day: Number(row.times_per_day) || 1,
                    balls_per_dose: Number(row.balls_per_dose) || 0,
                    instructions: row.instructions ? String(row.instructions).trim() : '',
                })),
            },
        ])
    );

    const buildRuleSnapshot = (rule) => {
        if (!rule) {
            return null;
        }

        const templateCode = String(rule.template_code || '').toUpperCase();
        return {
            amount_strategy: String(rule.amount_strategy || '').toUpperCase(),
            fixed_amount: rule.fixed_amount !== null && rule.fixed_amount !== undefined ? Number(rule.fixed_amount) : null,
            multiplier_value: rule.multiplier_value !== null && rule.multiplier_value !== undefined ? Number(rule.multiplier_value) : null,
            template_code: templateCode,
            doses: cloneDeep((templatesByCode.get(templateCode)?.rows || [])),
        };
    };

    const alphaCodes = (detail.alpha_codes || []).reduce((acc, row) => {
        const code = String(row.code || '').toUpperCase();
        if (!code || row.is_active === 0) {
            return acc;
        }

        const templateCode = String(row.template_code || '').toUpperCase();
        acc[code] = {
            code,
            description: row.description || null,
            fixed_amount: row.fixed_amount !== null && row.fixed_amount !== undefined ? Number(row.fixed_amount) : null,
            template_code: templateCode,
            duration_override_days: row.duration_override_days ? Number(row.duration_override_days) : null,
            doses: cloneDeep((templatesByCode.get(templateCode)?.rows || [])),
        };
        return acc;
    }, {});

    return {
        set_id: Number(detail.id),
        set_name: detail.set_name,
        version_no: Number(detail.version_no) || 1,
        updated_at: detail.updated_at,
        rules: {
            plain_number: buildRuleSnapshot(detail.rules?.plain_number),
            slash_single_numeric: buildRuleSnapshot(detail.rules?.slash_single_numeric),
            slash_double_numeric: buildRuleSnapshot(detail.rules?.slash_double_numeric),
            slash_price_numeric: buildRuleSnapshot(detail.rules?.slash_price_numeric),
        },
        alpha_codes: alphaCodes,
        templates: Array.from(templatesByCode.values()),
    };
};

const ensureDefaultFormulaSet = async ({ doctorId, actorUserId = null }) => withTransaction(async (connection) => {
    const [existingRows] = await connection.execute(
        `SELECT id
         FROM doctor_numeric_formula_sets
         WHERE doctor_id = ?
         LIMIT 1`,
        [doctorId]
    );

    if (existingRows.length > 0) {
        return Number(existingRows[0].id);
    }

    const payload = buildDefaultPayload();
    const [insertResult] = await connection.execute(
        `INSERT INTO doctor_numeric_formula_sets
         (doctor_id, set_name, description, is_default, is_active, is_published, version_no, published_at, created_by, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), ?, ?)`,
        [doctorId, payload.set_name, payload.description, 1, 1, 1, 1, actorUserId || doctorId, actorUserId || doctorId]
    );

    const formulaSetId = Number(insertResult.insertId);
    const templateIdByCode = new Map();

    for (const template of payload.templates) {
        const [templateResult] = await connection.execute(
            `INSERT INTO doctor_numeric_formula_templates
             (formula_set_id, template_code, template_name, is_default, is_active)
             VALUES (?, ?, ?, ?, ?)`,
            [formulaSetId, template.template_code, template.template_name, template.is_default ? 1 : 0, template.is_active ? 1 : 0]
        );

        const templateId = Number(templateResult.insertId);
        templateIdByCode.set(template.template_code, templateId);

        for (const row of template.rows) {
            await connection.execute(
                `INSERT INTO doctor_numeric_formula_template_rows
                 (template_id, dose_label, sort_order, times_per_day, balls_per_dose, instructions, is_active)
                 VALUES (?, ?, ?, ?, ?, ?, 1)`,
                [templateId, row.dose_label, row.sort_order, row.times_per_day, row.balls_per_dose, row.instructions || '']
            );
        }
    }

    for (const rule of Object.values(payload.rules)) {
        await connection.execute(
            `INSERT INTO doctor_numeric_formula_rules
             (formula_set_id, rule_key, amount_strategy, fixed_amount, multiplier_value, template_id, is_active)
             VALUES (?, ?, ?, ?, ?, ?, 1)`,
            [
                formulaSetId,
                rule.rule_key,
                rule.amount_strategy,
                rule.fixed_amount,
                rule.multiplier_value,
                templateIdByCode.get(rule.template_code) || null,
            ]
        );
    }

    for (const code of payload.alpha_codes) {
        await connection.execute(
            `INSERT INTO doctor_numeric_formula_alpha_codes
             (formula_set_id, code, description, fixed_amount, template_id, duration_override_days, is_active)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [
                formulaSetId,
                code.code,
                code.description,
                code.fixed_amount,
                templateIdByCode.get(code.template_code) || null,
                code.duration_override_days,
                code.is_active ? 1 : 0,
            ]
        );
    }

    await insertFormulaSetAuditLog(connection, {
        doctorId,
        formulaSetId,
        actionType: 'CREATE',
        entityType: 'FORMULA_SET',
        entityId: formulaSetId,
        beforeValue: null,
        afterValue: payload,
    });

    return formulaSetId;
});

const getActiveFormulaSetId = async ({ doctorId }) => {
    const rows = await query(
        `SELECT id
         FROM doctor_numeric_formula_sets
         WHERE doctor_id = ?
           AND is_active = 1
         ORDER BY updated_at DESC, id DESC
         LIMIT 1`,
        [doctorId]
    );

    if (rows.length > 0) {
        return Number(rows[0].id);
    }

    const fallbackRows = await query(
        `SELECT id
         FROM doctor_numeric_formula_sets
         WHERE doctor_id = ?
         ORDER BY updated_at DESC, id DESC
         LIMIT 1`,
        [doctorId]
    );

    if (fallbackRows.length > 0) {
        return Number(fallbackRows[0].id);
    }

    return ensureDefaultFormulaSet({ doctorId, actorUserId: doctorId });
};

const getDoctorFormulaSnapshot = async ({ doctorId, forceReload = false }) => {
    if (!forceReload && formulaSnapshotCache.has(Number(doctorId))) {
        return formulaSnapshotCache.get(Number(doctorId));
    }

    await ensureDefaultFormulaSet({ doctorId, actorUserId: doctorId });
    const activeSetId = await getActiveFormulaSetId({ doctorId });
    const detail = await getFormulaSetDetail({ doctorId, setId: activeSetId });
    const snapshot = buildFormulaSnapshotFromDetail(detail);
    formulaSnapshotCache.set(Number(doctorId), snapshot);
    return snapshot;
};

const refreshDoctorFormulaSnapshot = async ({ doctorId }) => {
    formulaSnapshotCache.delete(Number(doctorId));
    return getDoctorFormulaSnapshot({ doctorId, forceReload: true });
};

const upsertFormulaSet = async ({ doctorId, actorUserId, setId = null, payload }) => {
    const normalizedPayload = normalizeFormulaPayload(payload);
    const result = await withTransaction(async (connection) => {
        let targetSetId = setId ? Number(setId) : null;
        let previousDetail = null;
        let nextVersionNo = 1;

        if (targetSetId) {
            previousDetail = await getFormulaSetDetail({ doctorId, setId: targetSetId });
            if (!previousDetail) {
                throw new AppError('Formula set not found', 404);
            }
            nextVersionNo = (Number(previousDetail.version_no) || 1) + 1;

            await connection.execute(
                `UPDATE doctor_numeric_formula_sets
                 SET set_name = ?,
                     description = ?,
                     is_default = ?,
                     is_active = ?,
                     is_published = ?,
                     version_no = ?,
                     published_at = CASE WHEN ? = 1 THEN NOW() ELSE published_at END,
                     updated_by = ?,
                     updated_at = NOW()
                 WHERE id = ?
                   AND doctor_id = ?`,
                [
                    normalizedPayload.set_name,
                    normalizedPayload.description,
                    normalizedPayload.is_default ? 1 : 0,
                    normalizedPayload.is_active ? 1 : 0,
                    normalizedPayload.is_published ? 1 : 0,
                    nextVersionNo,
                    normalizedPayload.is_published ? 1 : 0,
                    actorUserId,
                    targetSetId,
                    doctorId,
                ]
            );

            await connection.execute(
                `DELETE FROM doctor_numeric_formula_alpha_codes
                 WHERE formula_set_id = ?`,
                [targetSetId]
            );
            await connection.execute(
                `DELETE tr
                 FROM doctor_numeric_formula_template_rows tr
                 JOIN doctor_numeric_formula_templates t
                   ON t.id = tr.template_id
                 WHERE t.formula_set_id = ?`,
                [targetSetId]
            );
            await connection.execute(
                `DELETE FROM doctor_numeric_formula_rules
                 WHERE formula_set_id = ?`,
                [targetSetId]
            );
            await connection.execute(
                `DELETE FROM doctor_numeric_formula_templates
                 WHERE formula_set_id = ?`,
                [targetSetId]
            );
        } else {
            const [insertResult] = await connection.execute(
                `INSERT INTO doctor_numeric_formula_sets
                 (doctor_id, set_name, description, is_default, is_active, is_published, version_no, published_at, created_by, updated_by)
                 VALUES (?, ?, ?, ?, ?, ?, 1, CASE WHEN ? = 1 THEN NOW() ELSE NULL END, ?, ?)`,
                [
                    doctorId,
                    normalizedPayload.set_name,
                    normalizedPayload.description,
                    normalizedPayload.is_default ? 1 : 0,
                    normalizedPayload.is_active ? 1 : 0,
                    normalizedPayload.is_published ? 1 : 0,
                    normalizedPayload.is_published ? 1 : 0,
                    actorUserId,
                    actorUserId,
                ]
            );
            targetSetId = Number(insertResult.insertId);
        }

        if (normalizedPayload.is_active) {
            await connection.execute(
                `UPDATE doctor_numeric_formula_sets
                 SET is_active = CASE WHEN id = ? THEN 1 ELSE 0 END,
                     updated_by = ?,
                     updated_at = NOW()
                 WHERE doctor_id = ?`,
                [targetSetId, actorUserId, doctorId]
            );
        }

        const templateIdByCode = new Map();

        for (const template of normalizedPayload.templates) {
            const [templateResult] = await connection.execute(
                `INSERT INTO doctor_numeric_formula_templates
                 (formula_set_id, template_code, template_name, is_default, is_active)
                 VALUES (?, ?, ?, ?, ?)`,
                [targetSetId, template.template_code, template.template_name, template.is_default ? 1 : 0, template.is_active ? 1 : 0]
            );
            const templateId = Number(templateResult.insertId);
            templateIdByCode.set(template.template_code, templateId);

            for (const row of template.rows) {
                await connection.execute(
                    `INSERT INTO doctor_numeric_formula_template_rows
                     (template_id, dose_label, sort_order, times_per_day, balls_per_dose, instructions, is_active)
                     VALUES (?, ?, ?, ?, ?, ?, 1)`,
                    [templateId, row.dose_label, row.sort_order, row.times_per_day, row.balls_per_dose, row.instructions || '']
                );
            }
        }

        const rulesToInsert = [
            { key: RULE_KEYS.plainNumber, value: normalizedPayload.rules.plain_number },
            { key: RULE_KEYS.slashSingleNumeric, value: normalizedPayload.rules.slash_single_numeric },
            { key: RULE_KEYS.slashDoubleNumeric, value: normalizedPayload.rules.slash_double_numeric },
            { key: RULE_KEYS.slashPriceNumeric, value: normalizedPayload.rules.slash_price_numeric },
        ];

        for (const ruleEntry of rulesToInsert) {
            await connection.execute(
                `INSERT INTO doctor_numeric_formula_rules
                 (formula_set_id, rule_key, amount_strategy, fixed_amount, multiplier_value, template_id, is_active)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [
                    targetSetId,
                    ruleEntry.key,
                    ruleEntry.value.amount_strategy,
                    ruleEntry.value.fixed_amount,
                    ruleEntry.value.multiplier_value,
                    templateIdByCode.get(ruleEntry.value.template_code) || null,
                    ruleEntry.value.is_active ? 1 : 0,
                ]
            );
        }

        for (const code of normalizedPayload.alpha_codes) {
            await connection.execute(
                `INSERT INTO doctor_numeric_formula_alpha_codes
                 (formula_set_id, code, description, fixed_amount, template_id, duration_override_days, is_active)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [
                    targetSetId,
                    code.code,
                    code.description,
                    code.fixed_amount,
                    templateIdByCode.get(code.template_code) || null,
                    code.duration_override_days,
                    code.is_active ? 1 : 0,
                ]
            );
        }

        await insertFormulaSetAuditLog(connection, {
            doctorId,
            formulaSetId: targetSetId,
            actionType: setId ? 'UPDATE' : 'CREATE',
            entityType: 'FORMULA_SET',
            entityId: targetSetId,
            beforeValue: previousDetail,
            afterValue: normalizedPayload,
        });

        return targetSetId;
    });

    const detail = await getFormulaSetDetail({ doctorId, setId: result });
    const snapshot = await refreshDoctorFormulaSnapshot({ doctorId });
    emitToUser(doctorId, 'doctor.formula-master.updated', {
        success: true,
        snapshot,
        set_id: detail?.id || null,
        version_no: detail?.version_no || null,
    });

    return {
        detail,
        snapshot,
    };
};

const activateFormulaSet = async ({ doctorId, actorUserId, setId }) => {
    const detail = await getFormulaSetDetail({ doctorId, setId });
    if (!detail) {
        throw new AppError('Formula set not found', 404);
    }

    await withTransaction(async (connection) => {
        await connection.execute(
            `UPDATE doctor_numeric_formula_sets
             SET is_active = CASE WHEN id = ? THEN 1 ELSE 0 END,
                 updated_by = ?,
                 updated_at = NOW()
             WHERE doctor_id = ?`,
            [setId, actorUserId, doctorId]
        );

        await insertFormulaSetAuditLog(connection, {
            doctorId,
            formulaSetId: setId,
            actionType: 'ACTIVATE',
            entityType: 'FORMULA_SET',
            entityId: setId,
            beforeValue: null,
            afterValue: { activated: true },
        });
    });

    const snapshot = await refreshDoctorFormulaSnapshot({ doctorId });
    emitToUser(doctorId, 'doctor.formula-master.updated', {
        success: true,
        snapshot,
        set_id: setId,
        version_no: snapshot?.version_no || null,
    });

    return snapshot;
};

const deleteFormulaSet = async ({ doctorId, actorUserId, setId }) => {
    const detail = await getFormulaSetDetail({ doctorId, setId });
    if (!detail) {
        throw new AppError('Formula set not found', 404);
    }

    const summaries = await getFormulaSetSummaries({ doctorId });
    if (summaries.length <= 1) {
        throw new AppError('At least one formula set must remain', 409);
    }

    await withTransaction(async (connection) => {
        await insertFormulaSetAuditLog(connection, {
            doctorId,
            formulaSetId: setId,
            actionType: 'DELETE',
            entityType: 'FORMULA_SET',
            entityId: setId,
            beforeValue: detail,
            afterValue: null,
        });

        await connection.execute(
            `DELETE FROM doctor_numeric_formula_alpha_codes
             WHERE formula_set_id = ?`,
            [setId]
        );
        await connection.execute(
            `DELETE tr
             FROM doctor_numeric_formula_template_rows tr
             JOIN doctor_numeric_formula_templates t
               ON t.id = tr.template_id
             WHERE t.formula_set_id = ?`,
            [setId]
        );
        await connection.execute(
            `DELETE FROM doctor_numeric_formula_rules
             WHERE formula_set_id = ?`,
            [setId]
        );
        await connection.execute(
            `DELETE FROM doctor_numeric_formula_templates
             WHERE formula_set_id = ?`,
            [setId]
        );
        await connection.execute(
            `DELETE FROM doctor_numeric_formula_sets
             WHERE id = ?
               AND doctor_id = ?`,
            [setId, doctorId]
        );
    });

    const remaining = await getFormulaSetSummaries({ doctorId });
    if (remaining.length > 0 && !remaining.some((item) => Number(item.is_active) === 1)) {
        await activateFormulaSet({ doctorId, actorUserId, setId: Number(remaining[0].id) });
    } else {
        await refreshDoctorFormulaSnapshot({ doctorId });
    }
};

const parseQuickFormulaInput = ({ rawInput, snapshot }) => {
    const source = String(rawInput || '').trim();
    if (!source) {
        return {
            input: '',
            tokens: [],
            entries: [],
            warnings: [],
            errors: [],
        };
    }

    if (!snapshot) {
        throw new AppError('Formula snapshot is not available for parsing', 409);
    }

    const tokens = splitQuickFormulaCommaItems(source);

    const entries = [];
    const warnings = [];
    const errors = [];
    const seenMedicineValues = new Set();

    const resolveAmountFromRule = (rule, suffixNumeric = null) => {
        if (!rule) {
            throw createValidationError('Formula rule not configured');
        }

        if (rule.amount_strategy === 'FIXED') {
            return toNonNegativeAmount(rule.fixed_amount);
        }

        if (rule.amount_strategy === 'MULTIPLY_SUFFIX') {
            if (suffixNumeric === null || suffixNumeric === undefined) {
                throw createValidationError('Numeric suffix is required for multiplier rule');
            }
            return Number((Number(suffixNumeric) * Number(rule.multiplier_value || 0)).toFixed(2));
        }

        if (rule.amount_strategy === 'SUFFIX_AS_PRICE') {
            if (suffixNumeric === null || suffixNumeric === undefined) {
                throw createValidationError('Numeric suffix is required for suffix-as-price rule');
            }
            return Number(Number(suffixNumeric).toFixed(2));
        }

        throw createValidationError('Unsupported formula amount strategy');
    };

    tokens.forEach((token) => {
        const match = token.match(NUMERIC_MEDICINE_TOKEN_RE);
        if (!match) {
            errors.push({
                raw_token: token,
                message: 'Token format is invalid. Use formats like 30, 12[14], 2[5,12,34], 200/2, 84/20, 10/BD',
            });
            return;
        }

        const medicineValueNumber = Number(match[1]);
        const powerValue = normalizeNumericMedicinePower(match[2] || null);
        const inlineAlphaRaw = match[3] ? String(match[3]).trim() : '';
        const inlineAlphaCode = inlineAlphaRaw ? inlineAlphaRaw.toUpperCase() : null;
        if (!Number.isInteger(medicineValueNumber) || medicineValueNumber < NUMERIC_MEDICINE_MIN || medicineValueNumber > NUMERIC_MEDICINE_MAX) {
            errors.push({
                raw_token: token,
                message: `Medicine number must be between ${NUMERIC_MEDICINE_MIN} and ${NUMERIC_MEDICINE_MAX}`,
            });
            return;
        }

        const medicineValue = `${medicineValueNumber}${powerValue ? `[${powerValue}]` : ''}${inlineAlphaRaw}`;
        const medicineDuplicateKey = medicineValue.toLowerCase();
        if (seenMedicineValues.has(medicineDuplicateKey)) {
            errors.push({
                raw_token: token,
                message: `Duplicate medicine ${medicineValue} is not allowed`,
            });
            return;
        }
        seenMedicineValues.add(medicineDuplicateKey);

        const suffix = match[4] ? String(match[4]).trim() : null;
        let resolvedRule = snapshot.rules?.plain_number || null;
        let suffixType = 'NONE';
        let suffixValue = null;
        let amount = resolveAmountFromRule(resolvedRule);
        let doses = cloneDeep(resolvedRule?.doses || []);
        let dosageTemplateCode = resolvedRule?.template_code || null;
        let durationOverrideDays = null;

        if (suffix) {
            suffixValue = suffix;
            if (/^\d+$/.test(suffix)) {
                const suffixNumber = Number(suffix);
                if (suffix.length === 1) {
                    resolvedRule = snapshot.rules?.slash_single_numeric || null;
                    suffixType = 'NUMERIC_SINGLE';
                } else if (suffix.length === 2) {
                    resolvedRule = snapshot.rules?.slash_double_numeric || null;
                    suffixType = 'NUMERIC_DOUBLE';
                } else {
                    resolvedRule = snapshot.rules?.slash_price_numeric || null;
                    suffixType = 'NUMERIC_PRICE';
                }

                amount = resolveAmountFromRule(resolvedRule, suffixNumber);
                doses = cloneDeep(resolvedRule?.doses || []);
                dosageTemplateCode = resolvedRule?.template_code || null;
            } else if (/^[A-Za-z]+$/.test(suffix)) {
                const alphaCode = suffix.toUpperCase();
                const codeRule = snapshot.alpha_codes?.[alphaCode] || null;
                if (!codeRule) {
                    errors.push({
                        raw_token: token,
                        message: `Unknown alpha code: ${alphaCode}`,
                    });
                    return;
                }

                suffixType = 'ALPHA';
                suffixValue = alphaCode;
                amount = codeRule.fixed_amount !== null && codeRule.fixed_amount !== undefined
                    ? Number(codeRule.fixed_amount)
                    : resolveAmountFromRule(snapshot.rules?.plain_number || null);
                doses = cloneDeep(codeRule.doses || []);
                dosageTemplateCode = codeRule.template_code || null;
                durationOverrideDays = codeRule.duration_override_days || null;
            } else {
                errors.push({
                    raw_token: token,
                    message: 'Suffix after / must be only numbers or only letters',
                });
                return;
            }
        }

        if (inlineAlphaCode) {
            const inlineRule = snapshot.alpha_codes?.[inlineAlphaCode] || null;
            if (!inlineRule) {
                errors.push({
                    raw_token: token,
                    message: `Unknown inline alpha code: ${inlineAlphaCode}`,
                });
                return;
            }

            doses = cloneDeep(inlineRule.doses || []);
            dosageTemplateCode = inlineRule.template_code || null;
            if (inlineRule.duration_override_days) {
                durationOverrideDays = inlineRule.duration_override_days;
            }
        }

        if (!Array.isArray(doses) || doses.length === 0) {
            errors.push({
                raw_token: token,
                message: 'Resolved dosage template has no dosage rows',
            });
            return;
        }

        entries.push({
            raw_token: token,
            medicine_type: 'NUMERIC',
            medicine_value: medicineValue,
            suffix_type: suffixType,
            suffix_value: suffixValue,
            dosage_template_code: dosageTemplateCode,
            duration_override_days: durationOverrideDays,
            amount,
            doses,
        });
    });

    return {
        input: source,
        tokens,
        entries,
        warnings,
        errors,
    };
};

module.exports = {
    RULE_KEYS,
    buildDefaultPayload,
    normalizeFormulaPayload,
    getFormulaSetSummaries,
    getFormulaSetDetail,
    buildFormulaSnapshotFromDetail,
    ensureDefaultFormulaSet,
    getDoctorFormulaSnapshot,
    refreshDoctorFormulaSnapshot,
    upsertFormulaSet,
    activateFormulaSet,
    deleteFormulaSet,
    parseQuickFormulaInput,
};
