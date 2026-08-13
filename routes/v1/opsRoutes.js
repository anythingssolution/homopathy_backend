const express = require('express');
const {
    getSystemLogsOverview,
    getSystemLogFile,
} = require('../../controllers/v1/systemLogsController');
const { authenticate } = require('../../middleware/authMiddleware');
const {
    requireOpsFeature,
    authorizeOpsUser,
} = require('../../middleware/opsAccessMiddleware');

const router = express.Router();

router.use(
    requireOpsFeature('enableBackendLogViewer'),
    authenticate,
    authorizeOpsUser
);
router.get('/system-logs/overview', getSystemLogsOverview);
router.get('/system-logs/file/:fileName', getSystemLogFile);

module.exports = router;
