const { buildMedicalReportScope, query } = require('./shared');

const getMedicalSummaryReport = async (filters) => {
    const { whereClause, params } = buildMedicalReportScope(filters);

    return query(
        `SELECT
            SUM(CASE WHEN c.workflow_status = 'READY_FOR_MEDICAL' THEN 1 ELSE 0 END) AS ready_prescriptions_count,
            SUM(CASE WHEN c.workflow_status = 'PROCESSED_BY_MEDICAL' THEN 1 ELSE 0 END) AS processed_prescriptions_count,
            COALESCE(SUM(mpp.total_amount), 0) AS total_pricing_amount
         FROM tbl_consultations c
         JOIN tbl_appointments a ON a.appointment_id = c.appointment_id
         LEFT JOIN tbl_medical_prescription_pricing mpp ON mpp.consultation_id = c.id
         ${whereClause}`,
        params
    );
};

module.exports = getMedicalSummaryReport;
