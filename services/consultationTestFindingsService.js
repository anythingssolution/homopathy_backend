const AppError = require('../utils/AppError');

const FINDING_TEXT_MAX = 1000;
const FINDING_NOTES_MAX = 2000;

const TEST_FINDING_SELECT_SQL = `
    f.id AS finding_id,
    f.finding_text,
    f.notes AS finding_notes,
    f.interpreted_by,
    f.interpreted_at
`;

const TEST_FINDING_JOIN_SQL = `
    LEFT JOIN tbl_consultation_test_findings f ON f.consultation_test_id = t.id
`;

const projectTestFindingFields = (row = {}) => ({
    finding_id: row.finding_id || null,
    finding_text: row.finding_text || null,
    finding_notes: row.finding_notes || null,
    interpreted_by: row.interpreted_by || null,
    interpreted_at: row.interpreted_at || null,
});

const normalizeTestFindingsPayload = ({ submittedFindings, prescribedTests }) => {
    if (!Array.isArray(submittedFindings)) {
        throw new AppError('findings array is required', 400);
    }

    const prescribedById = new Map(
        (prescribedTests || []).map((item) => [Number(item.consultation_test_id || item.id), item])
    );
    const seenIds = new Set();

    return submittedFindings.map((item, index) => {
        const testId = Number(item?.consultation_test_id);
        if (!Number.isInteger(testId) || testId <= 0) {
            throw new AppError(`findings[${index}].consultation_test_id is required`, 400);
        }

        if (seenIds.has(testId)) {
            throw new AppError(`Duplicate consultation test id ${testId}`, 400);
        }
        seenIds.add(testId);

        if (!prescribedById.has(testId)) {
            throw new AppError(`findings[${index}] does not belong to this consultation`, 400);
        }

        const findingText = item?.finding_text == null ? '' : String(item.finding_text).trim();
        const notes = item?.notes == null ? '' : String(item.notes).trim();

        if (findingText.length > FINDING_TEXT_MAX) {
            throw new AppError(`findings[${index}].finding_text must be at most ${FINDING_TEXT_MAX} characters`, 400);
        }
        if (notes.length > FINDING_NOTES_MAX) {
            throw new AppError(`findings[${index}].notes must be at most ${FINDING_NOTES_MAX} characters`, 400);
        }
        if (notes && !findingText) {
            throw new AppError(`findings[${index}].finding_text is required when notes are provided`, 400);
        }

        return {
            consultation_test_id: testId,
            finding_text: findingText || null,
            notes: notes || null,
        };
    });
};

const upsertConsultationTestFindings = async ({
    connection,
    consultationId,
    actorUserId,
    findings,
}) => {
    for (const item of findings) {
        if (!item.finding_text) {
            await connection.execute(
                `DELETE FROM tbl_consultation_test_findings
                 WHERE consultation_test_id = ?
                   AND consultation_id = ?`,
                [item.consultation_test_id, consultationId]
            );
            continue;
        }

        await connection.execute(
            `INSERT INTO tbl_consultation_test_findings
                (consultation_id, consultation_test_id, finding_text, notes, interpreted_by, interpreted_at, created_by, updated_by)
             VALUES (?, ?, ?, ?, ?, NOW(), ?, ?)
             ON DUPLICATE KEY UPDATE
                finding_text = VALUES(finding_text),
                notes = VALUES(notes),
                interpreted_by = VALUES(interpreted_by),
                interpreted_at = NOW(),
                updated_by = VALUES(updated_by)`,
            [
                consultationId,
                item.consultation_test_id,
                item.finding_text,
                item.notes,
                actorUserId,
                actorUserId,
                actorUserId,
            ]
        );
    }
};

module.exports = {
    FINDING_TEXT_MAX,
    FINDING_NOTES_MAX,
    TEST_FINDING_SELECT_SQL,
    TEST_FINDING_JOIN_SQL,
    projectTestFindingFields,
    normalizeTestFindingsPayload,
    upsertConsultationTestFindings,
};
