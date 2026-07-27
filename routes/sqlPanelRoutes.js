const express = require('express');
const {
    renderSqlPanel,
    getSchemaOverview,
    executeSqlQuery,
    exportDatabase,
} = require('../controllers/sqlPanelController');

const router = express.Router();

router.get('/', renderSqlPanel);
router.get('/schema', getSchemaOverview);
router.get('/export', exportDatabase);
router.post('/query', executeSqlQuery);

module.exports = router;
