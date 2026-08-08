const fs = require('fs');
const path = require('path');
const asyncHandler = require('../../utils/asyncHandler');
const AppError = require('../../utils/AppError');
const {
    listPatientRegistry,
    getPatientRecordDetail,
    listPatientVisits,
    listPatientHistory,
    listPatientTimeline,
    createClinicalDocument,
    getClinicalDocumentDownload,
    updateDocumentStatus,
    buildRequestMeta,
    toPositiveInt,
} = require('../../services/patientRecordsService');

const listPatients = asyncHandler(async (req, res) => {
    const result = await listPatientRegistry({
        filters: req.query || {},
        actor: req.user,
    });

    return res.status(200).json({
        success: true,
        data: result,
    });
});

const getPatientDetail = asyncHandler(async (req, res) => {
    const patientId = toPositiveInt(req.params.patient_id);
    if (!patientId) {
        throw new AppError('Valid patient_id is required', 400);
    }

    const result = await getPatientRecordDetail({
        patientId,
        actor: req.user,
    });

    return res.status(200).json({
        success: true,
        data: result,
    });
});

const listPatientHistoryController = asyncHandler(async (req, res) => {
    const patientId = toPositiveInt(req.params.patient_id);
    if (!patientId) {
        throw new AppError('Valid patient_id is required', 400);
    }

    const result = await listPatientHistory({
        patientId,
        filters: req.query || {},
        actor: req.user,
    });

    return res.status(200).json({
        success: true,
        data: result,
    });
});

const listPatientVisitsController = asyncHandler(async (req, res) => {
    const patientId = toPositiveInt(req.params.patient_id);
    if (!patientId) {
        throw new AppError('Valid patient_id is required', 400);
    }

    const result = await listPatientVisits({
        patientId,
        filters: req.query || {},
        actor: req.user,
    });

    return res.status(200).json({
        success: true,
        data: result,
    });
});

const listTimeline = asyncHandler(async (req, res) => {
    const result = await listPatientTimeline({
        filters: req.query || {},
        actor: req.user,
    });

    return res.status(200).json({
        success: true,
        data: result,
    });
});

const uploadDocument = asyncHandler(async (req, res) => {
    const result = await createClinicalDocument({
        file: req.file,
        payload: req.body || {},
        actor: req.user,
        requestMeta: buildRequestMeta(req),
    });

    return res.status(201).json({
        success: true,
        message: 'Clinical document uploaded successfully',
        data: result,
    });
});

const downloadDocument = asyncHandler(async (req, res) => {
    const documentId = toPositiveInt(req.params.document_id);
    if (!documentId) {
        throw new AppError('Valid document_id is required', 400);
    }

    const { document, absolutePath } = await getClinicalDocumentDownload({
        documentId,
        actor: req.user,
        requestMeta: buildRequestMeta(req),
    });

    res.setHeader('Content-Type', document.mime_type || 'application/octet-stream');
    res.setHeader('Content-Length', document.file_size);
    res.setHeader(
        'Content-Disposition',
        `attachment; filename="${path.basename(document.original_filename || `clinical-document-${document.id}`)}"`
    );

    return fs.createReadStream(absolutePath).pipe(res);
});

const archiveDocument = asyncHandler(async (req, res) => {
    const documentId = toPositiveInt(req.params.document_id);
    if (!documentId) {
        throw new AppError('Valid document_id is required', 400);
    }

    const result = await updateDocumentStatus({
        documentId,
        status: 'ARCHIVED',
        reason: req.body?.reason,
        actor: req.user,
        requestMeta: buildRequestMeta(req),
    });

    return res.status(200).json({
        success: true,
        message: 'Clinical document archived successfully',
        data: result,
    });
});

const deleteDocument = asyncHandler(async (req, res) => {
    const documentId = toPositiveInt(req.params.document_id);
    if (!documentId) {
        throw new AppError('Valid document_id is required', 400);
    }

    const result = await updateDocumentStatus({
        documentId,
        status: 'DELETED',
        reason: req.body?.reason,
        actor: req.user,
        requestMeta: buildRequestMeta(req),
    });

    return res.status(200).json({
        success: true,
        message: 'Clinical document deleted successfully',
        data: result,
    });
});

module.exports = {
    listPatients,
    getPatientDetail,
    listPatientVisits: listPatientVisitsController,
    listPatientHistory: listPatientHistoryController,
    listTimeline,
    uploadDocument,
    downloadDocument,
    archiveDocument,
    deleteDocument,
};
