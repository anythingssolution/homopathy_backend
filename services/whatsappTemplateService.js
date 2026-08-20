const { query } = require('../config/db');
const AppError = require('../utils/AppError');

const listWhatsAppTemplates = async ({ category = null, isActive = true } = {}) => {
    let sql = `
        SELECT id, template_name, language_code, category, body_template, parameter_mapping_json, approval_status, is_active, created_at
        FROM tbl_whatsapp_templates
        WHERE 1=1
    `;
    const params = [];

    if (isActive !== null) {
        sql += ' AND is_active = ?';
        params.push(isActive ? 1 : 0);
    }

    if (category) {
        sql += ' AND category = ?';
        params.push(category);
    }

    sql += ' ORDER BY template_name ASC';

    const rows = await query(sql, params);
    return rows.map((row) => ({
        ...row,
        parameter_mapping: row.parameter_mapping_json ? JSON.parse(row.parameter_mapping_json) : [],
    }));
};

const getWhatsAppTemplateByName = async (templateName, languageCode = 'en') => {
    const rows = await query(
        `SELECT id, template_name, language_code, category, body_template, parameter_mapping_json, approval_status, is_active
         FROM tbl_whatsapp_templates
         WHERE template_name = ? AND language_code = ? AND is_active = 1
         LIMIT 1`,
        [templateName, languageCode]
    );

    if (rows.length === 0) {
        throw new AppError(`WhatsApp template '${templateName}' not found or inactive`, 404);
    }

    const row = rows[0];
    return {
        ...row,
        parameter_mapping: row.parameter_mapping_json ? JSON.parse(row.parameter_mapping_json) : [],
    };
};

module.exports = {
    listWhatsAppTemplates,
    getWhatsAppTemplateByName,
};
