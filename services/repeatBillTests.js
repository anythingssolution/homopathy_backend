const AppError = require('../utils/AppError');

// New tests belong to this bill, never to the previous doctor prescription.
const resolveRepeatBillTests = async (connection, submitted = []) => {
    if (!Array.isArray(submitted)) throw new AppError('tests must be a list', 400);
    if (!submitted.length) return [];
    const ids = submitted.map((item) => Number(item?.master_test_id));
    if (ids.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
        throw new AppError('Select a valid test from Test Master', 400);
    }
    if (new Set(ids).size !== ids.length) throw new AppError('The same test cannot be added twice', 400);
    const [rows] = await connection.execute(
        `SELECT id, test_name, amount FROM master_lab_test_prices
         WHERE is_active = 1 AND id IN (${ids.map(() => '?').join(',')}) FOR UPDATE`, ids
    );
    const byId = new Map(rows.map((row) => [Number(row.id), row]));
    return submitted.map((item, index) => {
        const master = byId.get(ids[index]);
        if (!master) throw new AppError('Selected test is no longer available. Reload the test list.', 409);
        const amount = Number(master.amount);
        if (!Number.isFinite(amount) || amount < 0) throw new AppError('Selected test has an invalid master price', 400);
        if (item.amount !== undefined && (!Number.isFinite(Number(item.amount)) || Math.round(Number(item.amount) * 100) !== Math.round(amount * 100))) {
            throw new AppError('Test price has changed. Reload the test list before saving.', 409);
        }
        return { master_test_id: Number(master.id), test_name: master.test_name, amount };
    });
};

module.exports = { resolveRepeatBillTests };
