const asyncHandler = require('../../../utils/asyncHandler');
const { parseReportFilters } = require('./shared');
const { getDispensaryRegister } = require('../../../services/reports/medical/dispensaryRegister');

const getDispensaryRegisterController = asyncHandler(async (req,res) => {
    const data = await getDispensaryRegister(parseReportFilters(req));
    res.json({ success:true,message:'Dispensary register fetched',data });
});
module.exports = { getDispensaryRegisterController };
