const assert = require('node:assert/strict');
const test = require('node:test');

const {
    normalizeInvestigationPayload,
    replaceAppointmentInvestigations,
} = require('../services/patientInvestigationService');

test('investigation payload accepts clinic aliases and trims optional fields', () => {
    assert.deepEqual(
        normalizeInvestigationPayload([
            {
                type: 'x-ray',
                testName: ' Chest ',
                investigationDate: '2026-10-13',
                status: 'seen',
                findings: ' Normal ',
                reportReference: ' Outside lab ',
            },
        ]),
        [
            {
                id: null,
                investigation_type: 'X_RAY',
                test_name: 'Chest',
                investigation_date: '2026-10-13',
                status: 'REPORT_SEEN',
                findings: 'Normal',
                report_reference: 'Outside lab',
                document_id: null,
            },
        ]
    );

    assert.throws(
        () => normalizeInvestigationPayload([{ type: 'unknown', testName: 'CBC' }]),
        /Invalid investigation type/
    );
    assert.throws(
        () => normalizeInvestigationPayload([{ type: 'MRI', investigationDate: '13-10-2026' }]),
        /YYYY-MM-DD/
    );
});

test('replaceAppointmentInvestigations updates, inserts and soft-deletes appointment rows', async () => {
    const calls = [];
    const execute = async (sql, params = []) => {
        calls.push({ sql, params });
        if (sql.includes('SELECT id FROM tbl_patient_investigations')) {
            return [[{ id: 5 }, { id: 6 }]];
        }
        if (sql.includes('INSERT INTO tbl_patient_investigations')) {
            return [{ insertId: 7 }];
        }
        if (sql.includes('SELECT') && sql.includes('FROM tbl_patient_investigations')) {
            return [[
                {
                    id: 5,
                    appointment_id: 22,
                    consultation_id: 33,
                    patient_id: 44,
                    family_member_id: null,
                    fk_branch_id: 2,
                    doctor_id: 11,
                    investigation_type: 'MRI',
                    test_name: 'Brain',
                    status: 'DONE',
                },
                {
                    id: 7,
                    appointment_id: 22,
                    consultation_id: 33,
                    patient_id: 44,
                    family_member_id: null,
                    fk_branch_id: 2,
                    doctor_id: 11,
                    investigation_type: 'BLOOD_INVESTIGATION',
                    test_name: 'CBC',
                    status: 'ADVISED',
                },
            ]];
        }
        return [{}];
    };

    const rows = await replaceAppointmentInvestigations(execute, {
        appointmentId: 22,
        consultationId: 33,
        doctorId: 11,
        actorRole: 'DOC',
        actorUserId: 11,
        appointmentScope: {
            appointment_id: 22,
            fk_patient_id: 44,
            fk_patient_family_member_id: null,
            fk_branch_id: 2,
            status: 'Confirmed',
            is_active: 1,
        },
        investigations: [
            { id: 5, type: 'MRI', testName: 'Brain', status: 'DONE' },
            { type: 'blood', testName: 'CBC', status: 'ADVISED' },
        ],
    });

    assert.equal(rows.length, 2);
    assert.ok(calls.some((call) => call.sql.includes('UPDATE tbl_patient_investigations')));
    assert.ok(calls.some((call) => call.sql.includes('INSERT INTO tbl_patient_investigations')));
    assert.ok(calls.some((call) => call.sql.includes('is_active = 0')));
});
