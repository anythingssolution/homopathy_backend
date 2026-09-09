const { query } = require('../../config/db');
const asyncHandler = require('../../utils/asyncHandler');
const AppError = require('../../utils/AppError');

const normalizeTest = (body) => {
    const test_name = String(body.test_name || '').trim();
    const test_type = String(body.test_type || '').trim();
    const sample_call = String(body.sample_call || '').trim();
    const amount = Number(body.amount);
    if (!test_name || test_name.length > 255) throw new AppError('Test name is required (maximum 255 characters)', 400);
    if (!test_type || test_type.length > 150) throw new AppError('Category is required (maximum 150 characters)', 400);
    if (sample_call.length > 100) throw new AppError('Sample must be at most 100 characters', 400);
    if (body.amount === '' || body.amount == null || !Number.isFinite(amount) || amount < 0 || amount > 99999999.99) throw new AppError('Enter a valid non-negative test price', 400);
    if (![0, 1, '0', '1'].includes(body.is_active)) throw new AppError('Select Active or Inactive', 400);
    return [test_name, sample_call || null, Number(amount.toFixed(2)), test_type,
        test_name.toLowerCase().replace(/\s+/g, ' '), Number(body.is_active)];
};

const listLabTests = asyncHandler(async (req, res) => {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const size = 20;
    const params = [];
    const where = [];
    if (req.query.search) {
        where.push('(test_name LIKE ? OR test_type LIKE ? OR sample_call LIKE ?)');
        const term = `%${String(req.query.search).trim().slice(0,255)}%`;
        params.push(term, term, term);
    }
    if (['0','1'].includes(req.query.active)) { where.push('is_active = ?'); params.push(Number(req.query.active)); }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const [count, data, types] = await Promise.all([
        query(`SELECT COUNT(*) AS total FROM master_lab_test_prices ${clause}`, params),
        query(`SELECT id,test_name,sample_call,amount,test_type,is_active FROM master_lab_test_prices ${clause} ORDER BY test_name,id LIMIT ? OFFSET ?`, [...params,size,(page-1)*size]),
        query('SELECT DISTINCT test_type FROM master_lab_test_prices ORDER BY test_type'),
    ]);
    res.json({success:true,data,meta:{total:Number(count[0].total),page,page_size:size,total_pages:Math.max(1,Math.ceil(count[0].total/size)),types:types.map(row=>row.test_type)}});
});

const saveLabTest = asyncHandler(async (req, res) => {
    const values = normalizeTest(req.body);
    const id = req.params.id ? Number(req.params.id) : null;
    if (id !== null && (!Number.isSafeInteger(id) || id <= 0)) throw new AppError('Invalid test ID',400);
    try {
        if (id) {
            const existing = await query('SELECT id FROM master_lab_test_prices WHERE id = ?', [id]);
            if (!existing.length) throw new AppError('Test not found',404);
            await query('UPDATE master_lab_test_prices SET test_name=?,sample_call=?,amount=?,test_type=?,normalized_test_name=?,is_active=? WHERE id=?',[...values,id]);
        } else {
            await query('INSERT INTO master_lab_test_prices (test_name,sample_call,amount,test_type,normalized_test_name,is_active) VALUES (?,?,?,?,?,?)',values);
        }
    } catch (error) {
        if (error.code === 'ER_DUP_ENTRY') throw new AppError('This test already exists in this category. Edit the existing test.',409);
        throw error;
    }
    res.status(id ? 200 : 201).json({success:true,message:'Test saved successfully'});
});

module.exports = { listLabTests, saveLabTest, normalizeTest };
