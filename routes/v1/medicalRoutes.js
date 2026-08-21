const express = require('express');
const multer = require('multer');
const {
    listMedicalPrescriptions,
    listPricedMedicalPrescriptions,
    getMedicalPrescription,
    listRepeatMedicinePatients,
    getRepeatMedicineLastPrescription,
    createRepeatMedicineBillController,
    saveMedicalPrescriptionPricing,
    processMedicalPrescription,
    downloadMedicalProductImportTemplate,
    importMedicalProducts,
    listMedicalProductMasters,
    getMedicalProductMasterSummary,
    getMedicalProductMaster,
    createMedicalProductMaster,
    updateMedicalProductMaster,
    deleteMedicalProductMaster,
} = require('../../controllers/v1/medicalController');
const { getDoctorTextMedicineMasters } = require('../../controllers/v1/doctorController');
const {
    authenticate,
    authorizeModuleAccess,
    enforceSelectedBranchScope,
    authorizeConsultationBranchScope,
} = require('../../middleware/authMiddleware');

const router = express.Router();
const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 5 * 1024 * 1024,
    },
});

router.use(authenticate, authorizeModuleAccess('MEDICAL'), enforceSelectedBranchScope);

router.get('/masters/text-medicines', getDoctorTextMedicineMasters);
router.get('/repeat-medicine/patients', listRepeatMedicinePatients);
router.get('/repeat-medicine/patients/:patient_id/last-prescription', getRepeatMedicineLastPrescription);
router.post('/repeat-medicine/bills', createRepeatMedicineBillController);
router.get('/master-medical-products/template', downloadMedicalProductImportTemplate);
router.post('/master-medical-products/import', upload.single('file'), importMedicalProducts);
router.get('/master-medical-products/summary', getMedicalProductMasterSummary);
router.get('/master-medical-products', listMedicalProductMasters);
router.post('/master-medical-products', createMedicalProductMaster);
router.get('/master-medical-products/:id', getMedicalProductMaster);
router.put('/master-medical-products/:id', updateMedicalProductMaster);
router.delete('/master-medical-products/:id', deleteMedicalProductMaster);
router.get('/prescriptions', listMedicalPrescriptions);
router.get('/prescriptions/priced', listPricedMedicalPrescriptions);
router.get('/prescriptions/:consultation_id', authorizeConsultationBranchScope, getMedicalPrescription);
router.post('/prescriptions/:consultation_id/pricing', authorizeConsultationBranchScope, saveMedicalPrescriptionPricing);
router.post('/prescriptions/:consultation_id/process', authorizeConsultationBranchScope, processMedicalPrescription);

module.exports = router;
