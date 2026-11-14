const express = require('express');
const {
    listPatients,
    getPatientDetail,
    listPatientVisits,
    listPatientPrescriptionTimeline,
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

router.use(authenticate, authorizeRolesOrModuleAccess(['doctor', 'receptionist', 'medical'], 'RECEPTION'));

// Patient history can be read across clinic branches without changing the
// working branch. Writes and document operations keep their original guards.
router.get('/branches', async (req, res, next) => {
    try {
        const { query } = require('../../config/db');
        const branches = await query('SELECT id, branch_name FROM master_clinic_branches ORDER BY id');
        res.json({ success: true, data: branches });
    } catch (error) { next(error); }
});

router.get('/patients', listPatients);
router.get('/patients/:patient_id', getPatientDetail);
router.get('/patients/:patient_id/visits', listPatientVisits);
router.get('/patients/:patient_id/prescription-timeline', listPatientPrescriptionTimeline);
router.get('/patients/:patient_id/history', listPatientHistory);
router.get('/timeline', listTimeline);
router.use(enforceSelectedBranchScope);
router.post('/documents', uploadClinicalDocumentFile, uploadDocument);
router.get('/documents/:document_id/download', downloadDocument);
router.post('/documents/:document_id/archive', archiveDocument);
router.delete('/documents/:document_id', deleteDocument);

module.exports = router;
