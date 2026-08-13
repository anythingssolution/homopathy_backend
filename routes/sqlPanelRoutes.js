const express = require('express');
const {
    renderSqlPanel,
    getSchemaOverview,
    executeSqlQuery,
    exportDatabase,
} = require('../controllers/sqlPanelController');
const { authenticate } = require('../middleware/authMiddleware');
const {
    requireOpsFeature,
    authorizeOpsUser,
} = require('../middleware/opsAccessMiddleware');

const router = express.Router();

router.use(requireOpsFeature('enableSqlPanel'));
router.get('/', renderSqlPanel);
router.get('/schema', authenticate, authorizeOpsUser, getSchemaOverview);
router.get(
    '/export',
    requireOpsFeature('enableSqlExport'),
    authenticate,
    authorizeOpsUser,
    exportDatabase
);
router.post('/query', authenticate, authorizeOpsUser, executeSqlQuery);

module.exports = router;
