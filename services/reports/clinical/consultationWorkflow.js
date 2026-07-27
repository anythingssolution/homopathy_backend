const { buildClinicalReportScope, query } = require('./shared');

const getConsultationWorkflowReport = async (filters) => {
    const { whereClause, params } = buildClinicalReportScope(filters);

    return query(
        `SELECT
            c.workflow_status,
            COUNT(c.id) AS total_consultations,
            SUM(CASE WHEN c.doctor_finalized_at IS NOT NULL THEN 1 ELSE 0 END) AS finalized_count,
            SUM(CASE WHEN c.sent_to_medical_at IS NOT NULL THEN 1 ELSE 0 END) AS sent_to_medical_count,
            SUM(CASE WHEN c.medical_processed_at IS NOT NULL THEN 1 ELSE 0 END) AS processed_by_medical_count
         FROM tbl_consultations c
         JOIN tbl_appointments a ON a.appointment_id = c.appointment_id
         ${whereClause}
         GROUP BY c.workflow_status
         ORDER BY FIELD(c.workflow_status, 'DRAFT', 'READY_FOR_RECEPTION', 'APPROVED_BY_RECEPTION', 'REJECTED_BY_RECEPTION', 'READY_FOR_MEDICAL', 'PROCESSED_BY_MEDICAL', 'COMPLETED_NO_PRESCRIPTION'), c.workflow_status ASC`,
        params
    );
};

module.exports = getConsultationWorkflowReport;
