const test = require('node:test');
const assert = require('node:assert/strict');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_patient_records_secret';
process.env.DB_HOST = process.env.DB_HOST || '127.0.0.1';
process.env.DB_USER = process.env.DB_USER || 'test_user';
process.env.DB_NAME = process.env.DB_NAME || 'test_db';

const db = require('../config/db');
let registryQueries = [];
let queryResponder = null;
db.query = async (sql, params) => {
    registryQueries.push({ sql, params });
    if (queryResponder) return queryResponder(sql, params);
    return sql.includes('COUNT(DISTINCT p.id) AS total') ? [{ total: 45 }] : [];
};

const {
    buildSubject,
    buildVisitRecord,
    buildMedicinePurchaseVisitRecord,
    listPatientRegistry,
    listPatientVisits,
    parseRegistryFilters,
    parseTimelineFilters,
    sortPrescriptionTimelineItems,
    assertPatientHistoryScope,
} = require('../services/patientRecordsService');

test('prescription timeline orders consultations and medicine collections by actual event time', () => {
    const items = sortPrescriptionTimelineItems([
        { record_type: 'CONSULTATION', source_id: 30, event_at: '2026-09-24T10:30:00.000Z' },
        { record_type: 'DIRECT_MEDICINE', source_id: 91, event_at: '2026-09-24T12:00:00.000Z' },
        { record_type: 'REPEAT_MEDICINE', source_id: 90, event_at: '2026-09-24T11:15:00.000Z' },
        { record_type: 'CONSULTATION', source_id: 31, event_at: '2026-09-24T10:30:00.000Z' },
    ]);

    assert.deepEqual(items.map((item) => item.record_type), [
        'DIRECT_MEDICINE',
        'REPEAT_MEDICINE',
        'CONSULTATION',
        'CONSULTATION',
    ]);
    assert.deepEqual(items.slice(2).map((item) => item.source_id), [31, 30]);
});

test('patient record branch access accepts an active direct medicine bill without an appointment', async () => {
    registryQueries = [];
    queryResponder = (sql) => {
        if (sql.includes('FROM master_users')) return [{ id: 1594 }];
        if (sql.includes('UNION ALL') && sql.includes("rb.appointment_id IS NULL")) return [{ 1: 1 }];
        return [];
    };

    try {
        await assertPatientHistoryScope({
            patientId: 1594,
            branchId: 1,
            subjectScope: 'ALL',
        });
    } finally {
        queryResponder = null;
    }

    const accessQuery = registryQueries.find(({ sql }) => sql.includes('UNION ALL'));
    assert.ok(accessQuery);
    assert.match(accessQuery.sql, /rb\.patient_id = \?/);
    assert.match(accessQuery.sql, /rb\.fk_branch_id = \?/);
    assert.match(accessQuery.sql, /rb\.bill_type = 'MEDICATION'/);
    assert.deepEqual(accessQuery.params, [1594, 1, 1594, 1]);
});

test('patient registry defaults to natural displayed patient ID order before pagination', async () => {
    registryQueries = [];
    const result = await listPatientRegistry({ filters: { page: 2 }, actor: { selected_branch_id: 2 } });
    const { sql, params } = registryQueries[1];

    assert.equal(result.filters.sortBy, 'patient_id');
    assert.equal(result.filters.sortOrder, 'asc');
    assert.match(sql, /ORDER BY CASE WHEN p\.uuid REGEXP '\^DTH\[0-9\]\+\$'/);
    assert.match(sql, /CAST\(SUBSTRING\(p\.uuid, 4\) AS UNSIGNED\) END ASC/);
    assert.match(sql, /p\.uuid ASC, p\.id ASC\s+LIMIT \? OFFSET \?/);
    assert.deepEqual(params, [2, 2, 20, 20]);
    assert.equal(result.meta.total_pages, 3);
});

test('patient registry supports both directions for every sortable column', async () => {
    const expressions = {
        patient_id: 'p.uuid',
        full_name: 'p.full_name',
        mobile_no: 'p.mobile_no',
        visits: 'completed_appointments_count',
        latest_visit: 'latest_activity_date',
    };
    for (const [sort_by, expression] of Object.entries(expressions)) {
        for (const sort_order of ['asc', 'desc']) {
            registryQueries = [];
            await listPatientRegistry({ filters: { branch_id: 1, sort_by, sort_order } });
            const sql = registryQueries[1].sql;
            assert.ok(sql.includes(`${expression} ${sort_order.toUpperCase()}, p.id ASC`));
            if (sort_by === 'latest_visit') {
                assert.ok(sql.includes('ORDER BY latest_activity_date IS NULL ASC,'));
            }
        }
    }
});

test('patient registry sorting preserves global registrations and branch-scoped visit/search filters', async () => {
    registryQueries = [];
    await listPatientRegistry({
        filters: { branch_id: 2, patient_search: 'DTH22', sort_by: 'full_name', sort_order: 'desc', page_size: 10 },
    });
    for (const { sql, params } of registryQueries) {
        assert.ok(sql.includes("a.is_active = 1 AND a.status = 'Completed' AND a.fk_branch_id = ?"));
        assert.ok(sql.includes("p.role = 'PAT' AND p.is_active = 1"));
        assert.ok(sql.includes('p.clinic_patient_no LIKE ?'));
        assert.equal(params[0], 2);
        if (sql.includes('pickups.latest_medicine_pickup_date')) {
            assert.equal(params[1], 2);
            assert.deepEqual(params.slice(2, 9), Array(7).fill('%DTH22%'));
            assert.deepEqual(params.slice(9, 11), [2, '%DTH22%']);
        } else {
            assert.deepEqual(params.slice(1, 8), Array(7).fill('%DTH22%'));
            assert.deepEqual(params.slice(8, 10), [2, '%DTH22%']);
        }
        assert.ok(sql.includes('search_bill.bill_number LIKE ?'));
    }
    assert.ok(!registryQueries[1].sql.includes('p.fk_branch_id = ?'));
    assert.deepEqual(registryQueries[1].params.slice(-2), [10, 0]);
});

test('patient registry rejects unknown and unsafe sort parameters before database access', async () => {
    for (const invalid of [
        { sort_by: 'toString' },
        { sort_by: 'p.uuid DESC; DROP TABLE master_users' },
        { sort_order: 'desc; DELETE FROM master_users' },
        { sort_order: 'sideways' },
    ]) {
        registryQueries = [];
        await assert.rejects(
            listPatientRegistry({ filters: { branch_id: 1, ...invalid } }),
            (error) => error.statusCode === 400 && error.message.startsWith('sort_')
        );
        assert.equal(registryQueries.length, 0);
    }
    assert.equal(parseRegistryFilters({ branch_id: 1, sort_by: ' FULL_NAME ', sort_order: ' DESC ' }).sortOrder, 'desc');
});

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
        medication_bill_id: 13,
        delivery_mode: 'COURIER',
        delivery_details_json: '{"courier_address":"Raipur","tracking_no":"AWB-13"}',
        dispensed_at: '2026-07-28T12:30:00.000Z',
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
    assert.equal(visit.details.medication_bill_id, 13);
    assert.equal(visit.details.delivery_mode, 'COURIER');
    assert.deepEqual(visit.details.delivery_details, { courier_address: 'Raipur', tracking_no: 'AWB-13' });
    assert.equal(visit.details.dispensed_at, '2026-07-28T12:30:00.000Z');
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

test('patient medicine pickup record is explicit and does not pretend to be a consultation', () => {
    const record = buildMedicinePurchaseVisitRecord({
        bill_id: 7140,
        bill_number: 'BILL240920260001',
        bill_type: 'MEDICATION',
        event_date: '2026-09-24T16:00:58.000Z',
        fk_branch_id: 1,
        branch_name: 'Lily Chowk Branch',
        patient_id: 1594,
        patient_uuid: 'DTH11491',
        primary_patient_full_name: 'DR .RAHUL RAJ',
        patient_full_name: 'DR .RAHUL RAJ',
        medicine_count: 2,
        medicine_summary: 'BT WILD FIRE TAB, 14,16/12 + 70Q/15',
        total_amount: 959,
        paid_amount: 959,
        pending_amount: 0,
        payment_status: 'PAID',
        delivery_mode: 'HAND',
        is_direct_medicine: 1,
    });

    assert.equal(record.timeline_type, 'MEDICINE_PURCHASE');
    assert.equal(record.record_type, 'DIRECT_MEDICINE');
    assert.equal(record.consultation_id, null);
    assert.equal(record.appointment_id, null);
    assert.equal(record.details.medicine_count, 2);
    assert.equal(record.details.has_prescription, false);
    assert.equal(record.subject.display_name, 'DR .RAHUL RAJ');
});

test('open patient record merges medicine pickups with clinical visits in event order', async () => {
    registryQueries = [];
    queryResponder = (sql) => {
        if (sql.includes('FROM master_users') && sql.includes("role = 'PAT'")) return [{ id: 55 }];
        if (sql.includes('UNION ALL') && sql.includes("rb.appointment_id IS NULL")) return [{ 1: 1 }];
        if (sql.includes('FROM tbl_appointments a') && sql.includes('a.appointment_id')) {
            return [{
                appointment_id: 10,
                appointment_date: '2026-09-20T10:00:00.000Z',
                status: 'Completed',
                fk_branch_id: 1,
                patient_id: 55,
                patient_uuid: 'DTH55',
                primary_patient_full_name: 'Test Patient',
                patient_full_name: 'Test Patient',
            }];
        }
        if (sql.includes('FROM tbl_bills rb') && sql.includes('GROUP BY rb.id')) {
            return [{
                bill_id: 20,
                bill_number: 'BILL-20',
                bill_type: 'MEDICATION',
                event_date: '2026-09-21T11:00:00.000Z',
                fk_branch_id: 1,
                patient_id: 55,
                patient_uuid: 'DTH55',
                primary_patient_full_name: 'Test Patient',
                patient_full_name: 'Test Patient',
                medicine_count: 1,
                medicine_summary: 'Medicine A',
                is_direct_medicine: 1,
            }];
        }
        return [];
    };

    try {
        const result = await listPatientVisits({
            patientId: 55,
            filters: { page_size: 20 },
            actor: { selected_branch_id: 1 },
        });
        assert.deepEqual(result.items.map((item) => item.timeline_type), ['MEDICINE_PURCHASE', 'VISIT']);
        assert.equal(result.meta.total, 2);
        assert.deepEqual(result.meta.breakdown, {
            clinical_visits: 1,
            medicine_pickups: 1,
            direct_medicine: 1,
            repeat_medicine: 0,
        });
    } finally {
        queryResponder = null;
    }
});
