const express = require('express');
const {
    listPatients,
    getPatientDetail,
    listPatientVisits,
    listPatientHistory,
    listTimeline,
    uploadDocument,
    downloadDocument,
    archiveDocument,
    deleteDocument,
} = require('../../controllers/v1/patientRecordsController');
const {
    authenticate,
    authorizeRolesOrModuleAccess,
    enforceSelectedBranchScope,
} = require('../../middleware/authMiddleware');
const { uploadClinicalDocumentFile } = require('../../middleware/clinicalDocumentUploadMiddleware');

const router = express.Router();

router.use(authenticate, authorizeRolesOrModuleAccess(['doctor', 'receptionist', 'medical'], 'RECEPTION'), enforceSelectedBranchScope);

router.get('/patients', listPatients);
router.get('/patients/:patient_id', getPatientDetail);
router.get('/patients/:patient_id/visits', listPatientVisits);
router.get('/patients/:patient_id/history', listPatientHistory);
router.get('/timeline', listTimeline);
router.post('/documents', uploadClinicalDocumentFile, uploadDocument);
router.get('/documents/:document_id/download', downloadDocument);
router.post('/documents/:document_id/archive', archiveDocument);
router.delete('/documents/:document_id', deleteDocument);

module.exports = router;
