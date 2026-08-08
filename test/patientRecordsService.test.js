const test = require('node:test');
const assert = require('node:assert/strict');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_patient_records_secret';
process.env.DB_HOST = process.env.DB_HOST || '127.0.0.1';
process.env.DB_USER = process.env.DB_USER || 'test_user';
process.env.DB_NAME = process.env.DB_NAME || 'test_db';

const {
    buildSubject,
    buildVisitRecord,
    parseTimelineFilters,
} = require('../services/patientRecordsService');

test('patient record subject keeps primary patient records as self', () => {
    const subject = buildSubject({
        is_family_member_booking: 0,
        patient_id: 11,
        patient_uuid: 'PAT290720260001',
        primary_patient_full_name: 'Ayushi Sinha',
        primary_patient_mobile_no: '9999999999',
        patient_full_name: 'Ayushi Sinha',
        patient_age: 16,
        patient_gender: 'female',
    });

    assert.deepEqual(subject, {
        subject_type: 'SELF',
        patient_id: 11,
        patient_uuid: 'PAT290720260001',
        primary_patient_full_name: 'Ayushi Sinha',
        primary_patient_mobile_no: '9999999999',
        family_member_id: null,
        family_member_relationship: null,
        relationship_label: 'Self',
        display_name: 'Ayushi Sinha',
        age: 16,
        gender: 'female',
    });
});

test('patient record subject keeps linked family member identity and relationship', () => {
    const subject = buildSubject({
        is_family_member_booking: 1,
        fk_patient_family_member_id: 42,
        family_member_relationship: 'Daughter',
        patient_id: 11,
        patient_uuid: 'PAT290720260001',
        primary_patient_full_name: 'Ayushi Sinha',
        primary_patient_mobile_no: '9999999999',
        patient_full_name: 'Riya Sinha',
        patient_age: 8,
        patient_gender: 'female',
    });

    assert.equal(subject.subject_type, 'FAMILY_MEMBER');
    assert.equal(subject.patient_id, 11);
    assert.equal(subject.family_member_id, 42);
    assert.equal(subject.relationship_label, 'Daughter');
    assert.equal(subject.display_name, 'Riya Sinha');
    assert.equal(subject.primary_patient_full_name, 'Ayushi Sinha');
});

test('patient record timeline filters preserve branch, doctor, date, and document type semantics', () => {
    const filters = parseTimelineFilters({
        branch_id: 2,
        patient_search: 'PAT290720260001',
        doctor_id: 7,
        from_date: '2026-07-01',
        to_date: '2026-07-29',
        document_type: 'lab_report',
        timeline_type: 'document',
    });

    assert.equal(filters.branchId, 2);
    assert.equal(filters.patientSearch, 'PAT290720260001');
    assert.equal(filters.doctorId, 7);
    assert.equal(filters.fromDate, '2026-07-01');
    assert.equal(filters.toDate, '2026-07-29');
    assert.equal(filters.documentType, 'LAB_REPORT');
    assert.equal(filters.timelineType, 'DOCUMENT');
    assert.equal(filters.page, 1);
    assert.equal(filters.pageSize, 20);
});

test('patient visit record treats consultation aggregate as printable prescription source', () => {
    const visit = buildVisitRecord({
        appointment_id: 77,
        auid: 'AUID280720260052',
        appointment_date: '2026-07-28',
        status: 'Completed',
        fk_branch_id: 2,
        branch_name: 'Main',
        doctor_id: 9,
        doctor_full_name: 'Doctor One',
        consultation_id: 88,
        workflow_status: 'COMPLETED_NO_PRESCRIPTION',
        medication_duration_days: 14,
        medicine_count: 0,
        quick_formula_input: '3 + 5 + 6',
        oxygen_saturation: '98',
        blood_pressure: '120/80',
        patient_height: '170',
        patient_weight: '65',
        test_count: 0,
        bills_count: 1,
        bill_id: 12,
        bill_number: 'BILL-12',
        total_amount: 500,
        documents_count: 1,
        document_types: 'PRESCRIPTION',
        is_family_member_booking: 0,
        patient_id: 11,
        patient_uuid: 'PAT280720260001',
        primary_patient_full_name: '1 NO',
        primary_patient_mobile_no: '9999999999',
        patient_full_name: '1 NO',
    });

    assert.equal(visit.timeline_type, 'VISIT');
    assert.equal(visit.source_id, 77);
    assert.equal(visit.appointment_id, 77);
    assert.equal(visit.consultation_id, 88);
    assert.equal(visit.details.auid, 'AUID280720260052');
    assert.equal(visit.details.quick_formula_input, '3 + 5 + 6');
    assert.deepEqual({
        oxygen_saturation: visit.details.oxygen_saturation,
        blood_pressure: visit.details.blood_pressure,
        patient_height: visit.details.patient_height,
        patient_weight: visit.details.patient_weight,
    }, {
        oxygen_saturation: '98',
        blood_pressure: '120/80',
        patient_height: '170',
        patient_weight: '65',
    });
    assert.equal(visit.details.has_prescription, true);
    assert.equal(visit.details.has_medical_items, false);
    assert.equal(visit.details.bills_count, 1);
    assert.equal(visit.details.documents_count, 1);
    assert.equal(visit.subject.relationship_label, 'Self');
});

test('patient visit record returns null when quick formula input is absent', () => {
    const visit = buildVisitRecord({
        appointment_id: 78,
        appointment_date: '2026-07-29',
    });

    assert.equal(visit.details.quick_formula_input, null);
    assert.equal(visit.details.oxygen_saturation, null);
    assert.equal(visit.details.blood_pressure, null);
    assert.equal(visit.details.patient_height, null);
    assert.equal(visit.details.patient_weight, null);
});
