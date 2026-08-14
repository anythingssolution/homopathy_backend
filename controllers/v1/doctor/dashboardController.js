const {
    query,
    AppError,
    asyncHandler,
    decorateTokenFields,
    getAppointmentPatientJoin,
    getBookingSubjectExpression,
    toPositiveInt,
    isValidDateString,
    DOCTOR_APPOINTMENT_SELECT,
    normalizeMasterValue,
    buildTextMedicineProductMasters,
} = require('./shared');

const getDoctorDashboard = asyncHandler(async (req, res) => {
    const today = req.query.date ? String(req.query.date).trim() : new Date().toISOString().slice(0, 10);
    let branchId = req.query.branch_id !== undefined ? toPositiveInt(req.query.branch_id) : null;
    if (branchId === null && req.user?.branch_id) {
        branchId = toPositiveInt(req.user.branch_id);
    }

    if (!isValidDateString(today)) {
        throw new AppError('date must be in YYYY-MM-DD format', 400);
    }

    if (req.query.branch_id !== undefined && !req.query.branch_id) {
        throw new AppError('branch_id must be a positive integer', 400);
    }

    const params = [];
    let branchWhere = '';
    let subqueryBranchWhere = '';

    if (branchId) {
        branchWhere = ' AND a.fk_branch_id = ?';
        params.push(branchId);
    }

    const [summaryRows, branchSummary, upcomingAppointments, recentConsultations] = await Promise.all([
        query(
            `SELECT
                COUNT(*) AS total_appointments,
                SUM(CASE WHEN a.appointment_date = ? THEN 1 ELSE 0 END) AS today_appointments,
                SUM(CASE WHEN a.appointment_date = ? AND a.status = 'Pending' THEN 1 ELSE 0 END) AS today_pending,
                SUM(CASE WHEN a.appointment_date = ? AND a.status = 'Completed' THEN 1 ELSE 0 END) AS today_completed,
                SUM(CASE WHEN a.status = 'Cancelled' THEN 1 ELSE 0 END) AS cancelled_appointments,
                COUNT(DISTINCT ${getBookingSubjectExpression('a')}) AS unique_patients,
                SUM(CASE WHEN a.status = 'Completed' THEN 1 ELSE 0 END) AS total_consultations
             FROM tbl_appointments a
             WHERE a.is_active = 1 ${branchWhere}`,
            [today, today, today, ...params]
        ),
        query(
            `SELECT
                b.id AS branch_id,
                b.branch_name,
                COUNT(a.appointment_id) AS total_appointments,
                SUM(CASE WHEN a.appointment_date = ? THEN 1 ELSE 0 END) AS today_appointments,
                SUM(CASE WHEN a.status = 'Completed' THEN 1 ELSE 0 END) AS completed_appointments
             FROM master_clinic_branches b
             LEFT JOIN tbl_appointments a ON a.fk_branch_id = b.id
             ${branchId ? 'WHERE b.id = ?' : ''}
             GROUP BY b.id, b.branch_name
             ORDER BY b.branch_name ASC`,
            branchId ? [today, branchId] : [today]
        ),
        query(
            `${DOCTOR_APPOINTMENT_SELECT}
             WHERE a.appointment_date >= ?
             ${branchId ? 'AND a.fk_branch_id = ?' : ''}
             ORDER BY a.appointment_date ASC, a.current_token_number ASC
             LIMIT 5`,
            branchId ? [today, branchId] : [today]
        ),
        query(
            `SELECT
                c.id AS consultation_id,
                c.appointment_id,
                c.medication_duration_days,
                c.created_at,
                a.booked_for_type,
                a.fk_patient_family_member_id,
                COALESCE(fm.full_name, p.full_name) AS patient_full_name,
                p.mobile_no AS patient_mobile_no
             FROM tbl_consultations c
             JOIN tbl_appointments a ON a.appointment_id = c.appointment_id
             JOIN master_users p ON p.id = a.fk_patient_id
             LEFT JOIN tbl_patient_family_members fm
               ON fm.id = a.fk_patient_family_member_id
             ${branchId ? 'WHERE a.fk_branch_id = ?' : ''}
             ORDER BY c.created_at DESC
             LIMIT 5`,
            branchId ? [branchId] : []
        ),
    ]);

    return res.status(200).json({
        success: true,
        message: 'Doctor dashboard fetched successfully',
        data: {
            summary: summaryRows[0] || {},
            branch_summary: branchSummary,
            upcoming_appointments: upcomingAppointments.map((appointment) => decorateTokenFields(appointment)),
            recent_consultations: recentConsultations,
        },
        meta: {
            filters: {
                date: today,
                branch_id: branchId,
            },
        },
    });
});

const listPatientsForDoctor = asyncHandler(async (req, res) => {
    let branchId = req.query.branch_id !== undefined ? toPositiveInt(req.query.branch_id) : null;
    if (branchId === null && req.user?.branch_id) {
        branchId = toPositiveInt(req.user.branch_id);
    }
    const patientSearch = req.query.search ? String(req.query.search).trim() : null;
    const visitType = req.query.type ? String(req.query.type).trim().toLowerCase() : null;

    if (req.query.branch_id !== undefined && !req.query.branch_id) {
        throw new AppError('branch_id must be a positive integer', 400);
    }

    if (visitType && !['all', 'recent', 'followup_pending'].includes(visitType)) {
        throw new AppError('type must be one of all, recent or followup_pending', 400);
    }

    const params = [];
    const conditions = [];

    if (branchId) {
        conditions.push('a.fk_branch_id = ?');
        params.push(branchId);
    }

    if (patientSearch) {
        conditions.push('(p.full_name LIKE ? OR p.mobile_no LIKE ? OR p.uuid LIKE ?)');
        params.push(`%${patientSearch}%`, `%${patientSearch}%`, `%${patientSearch}%`);
    }

    if (visitType === 'recent') {
        conditions.push('a.appointment_date >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)');
    }

    if (visitType === 'followup_pending') {
        conditions.push(`EXISTS (
            SELECT 1
            FROM tbl_appointments a2
            WHERE a2.fk_patient_id = p.id
              AND a2.status IN ('Pending', 'Confirmed')
        )`);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const patients = await query(
        `SELECT
            p.id AS patient_id,
            p.uuid AS patient_uuid,
            p.full_name,
            p.age,
            p.gender,
            p.email,
            p.mobile_no,
            p.description,
            COUNT(DISTINCT a.appointment_id) AS total_appointments,
            SUM(CASE WHEN a.status = 'Completed' THEN 1 ELSE 0 END) AS completed_appointments,
            SUM(CASE WHEN a.status IN ('Pending', 'Confirmed') THEN 1 ELSE 0 END) AS active_appointments,
            SUM(CASE WHEN a.status = 'Cancelled' THEN 1 ELSE 0 END) AS cancelled_appointments,
            MAX(a.appointment_date) AS last_appointment_date
         FROM master_users p
         JOIN tbl_appointments a ON a.fk_patient_id = p.id
         ${whereClause}
         GROUP BY p.id, p.uuid, p.full_name, p.age, p.gender, p.email, p.mobile_no, p.description
         ORDER BY last_appointment_date DESC, p.full_name ASC`,
        params
    );

    return res.status(200).json({
        success: true,
        message: 'Doctor patients fetched successfully',
        data: patients,
        meta: {
            filters: {
                branch_id: branchId,
                search: patientSearch,
                type: visitType || 'all',
            },
            total: patients.length,
        },
    });
});

const getDoctorReports = asyncHandler(async (req, res) => {
    const reportType = req.query.type ? String(req.query.type).trim().toLowerCase() : 'summary';
    const fromDate = req.query.from ? String(req.query.from).trim() : null;
    const toDate = req.query.to ? String(req.query.to).trim() : null;
    const branchId = req.query.branch_id !== undefined ? toPositiveInt(req.query.branch_id) : null;

    if (fromDate && !isValidDateString(fromDate)) {
        throw new AppError('from must be in YYYY-MM-DD format', 400);
    }
    if (toDate && !isValidDateString(toDate)) {
        throw new AppError('to must be in YYYY-MM-DD format', 400);
    }
    if (req.query.branch_id !== undefined && !branchId) {
        throw new AppError('branch_id must be a positive integer', 400);
    }
    if (!['summary', 'branch', 'treatment', 'consultation', 'patient'].includes(reportType)) {
        throw new AppError('type must be one of summary, branch, treatment, consultation or patient', 400);
    }

    const conditions = [];
    const params = [];

    if (fromDate) {
        conditions.push('a.appointment_date >= ?');
        params.push(fromDate);
    }
    if (toDate) {
        conditions.push('a.appointment_date <= ?');
        params.push(toDate);
    }
    if (branchId) {
        conditions.push('a.fk_branch_id = ?');
        params.push(branchId);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    let rows = [];

    if (reportType === 'branch') {
        rows = await query(
            `SELECT
                b.id AS branch_id,
                b.branch_name,
                COUNT(a.appointment_id) AS total_appointments,
                SUM(CASE WHEN a.status = 'Pending' THEN 1 ELSE 0 END) AS pending_appointments,
                SUM(CASE WHEN a.status = 'Completed' THEN 1 ELSE 0 END) AS completed_appointments,
                SUM(CASE WHEN a.status = 'Cancelled' THEN 1 ELSE 0 END) AS cancelled_appointments
             FROM tbl_appointments a
             JOIN master_clinic_branches b ON b.id = a.fk_branch_id
             ${whereClause}
             GROUP BY b.id, b.branch_name
             ORDER BY total_appointments DESC, b.branch_name ASC`,
            params
        );
    } else if (reportType === 'treatment') {
        rows = await query(
            `SELECT
                t.id AS treatment_id,
                t.treatment_name,
                COUNT(a.appointment_id) AS total_appointments,
                SUM(CASE WHEN a.status = 'Completed' THEN 1 ELSE 0 END) AS completed_appointments
             FROM tbl_appointments a
             JOIN master_treatments t ON t.id = a.fk_treatment_id
             ${whereClause}
             GROUP BY t.id, t.treatment_name
             ORDER BY total_appointments DESC, t.treatment_name ASC`,
            params
        );
    } else if (reportType === 'consultation') {
        rows = await query(
            `SELECT
                c.id AS consultation_id,
                c.appointment_id,
                c.medication_duration_days,
                c.created_at,
                p.id AS patient_id,
                COALESCE(fm.full_name, p.full_name) AS patient_full_name,
                b.branch_name,
                t.treatment_name
             FROM tbl_consultations c
             JOIN tbl_appointments a ON a.appointment_id = c.appointment_id
             JOIN master_users p ON p.id = a.fk_patient_id
             LEFT JOIN tbl_patient_family_members fm
               ON fm.id = a.fk_patient_family_member_id
             JOIN master_clinic_branches b ON b.id = a.fk_branch_id
             JOIN master_treatments t ON t.id = a.fk_treatment_id
             ${whereClause}
             ORDER BY c.created_at DESC`,
            params
        );
    } else if (reportType === 'patient') {
        rows = await query(
            `SELECT
                p.id AS patient_id,
                p.uuid AS patient_uuid,
                COALESCE(fm.full_name, p.full_name) AS full_name,
                p.mobile_no,
                COUNT(a.appointment_id) AS total_appointments,
                MAX(a.appointment_date) AS last_appointment_date
             FROM tbl_appointments a
             JOIN master_users p ON p.id = a.fk_patient_id
             LEFT JOIN tbl_patient_family_members fm
               ON fm.id = a.fk_patient_family_member_id
             ${whereClause}
             GROUP BY p.id, p.uuid, COALESCE(fm.full_name, p.full_name), p.mobile_no
             ORDER BY total_appointments DESC, last_appointment_date DESC`,
            params
        );
    } else {
        rows = await query(
            `SELECT
                COUNT(a.appointment_id) AS total_appointments,
                SUM(CASE WHEN a.status = 'Pending' THEN 1 ELSE 0 END) AS pending_appointments,
                SUM(CASE WHEN a.status = 'Confirmed' THEN 1 ELSE 0 END) AS confirmed_appointments,
                SUM(CASE WHEN a.status = 'Completed' THEN 1 ELSE 0 END) AS completed_appointments,
                SUM(CASE WHEN a.status = 'Cancelled' THEN 1 ELSE 0 END) AS cancelled_appointments,
                COUNT(DISTINCT ${getBookingSubjectExpression('a')}) AS unique_patients,
                COUNT(DISTINCT a.fk_branch_id) AS unique_branches,
                COUNT(DISTINCT a.fk_treatment_id) AS unique_treatments
             FROM tbl_appointments a
             ${whereClause}`,
            params
        );
    }

    return res.status(200).json({
        success: true,
        message: 'Doctor reports fetched successfully',
        data: rows,
        meta: {
            filters: {
                type: reportType,
                from: fromDate,
                to: toDate,
                branch_id: branchId,
            },
            total: rows.length,
        },
    });
});

const getDoctorTextMedicineMasters = asyncHandler(async (_req, res) => {
    const [textMedicines, textMedicineRemarks, scopedTextMedicineRemarks, labTests] = await Promise.all([
        query(
            `SELECT id, medicine_value, normalized_value, is_active, is_doctor_manual, created_at, updated_at
             FROM master_text_medicines
             WHERE is_active = 1
             ORDER BY medicine_value ASC`
        ),
        query(
            `SELECT id, remark_value, normalized_value, is_active, created_at, updated_at
             FROM master_text_medicine_remarks
             WHERE is_active = 1
               AND (normalized_selection_value IS NULL OR normalized_selection_value = '')
             ORDER BY remark_value ASC`
        ).catch((error) => {
            if (error?.code === 'ER_BAD_FIELD_ERROR') {
                return query(
                    `SELECT id, remark_value, normalized_value, is_active, created_at, updated_at
                     FROM master_text_medicine_remarks
                     WHERE is_active = 1
                     ORDER BY remark_value ASC`
                );
            }

            throw error;
        }),
        query(
            `SELECT id, remark_value, normalized_value, selection_value, normalized_selection_value,
                    medicine_value, variant_value, normalized_medicine_value, normalized_variant_value,
                    is_active, created_at, updated_at
             FROM master_text_medicine_remarks
             WHERE is_active = 1
               AND normalized_selection_value IS NOT NULL
               AND normalized_selection_value <> ''
             ORDER BY selection_value ASC, remark_value ASC`
        ).catch((error) => {
            if (error?.code === 'ER_BAD_FIELD_ERROR') {
                return [];
            }

            throw error;
        }),
        query(
            `SELECT id, test_name, sample_call, amount, test_type, normalized_test_name, is_active, created_at, updated_at
             FROM master_lab_test_prices
             WHERE is_active = 1
             ORDER BY test_type ASC, test_name ASC`
        ),
    ]);

    const productMasters = await buildTextMedicineProductMasters(textMedicines);
    const scopedRemarksBySelectionValue = new Map();

    scopedTextMedicineRemarks.forEach((remark) => {
        const key = String(remark.normalized_selection_value || '').trim();
        if (!key) {
            return;
        }

        if (!scopedRemarksBySelectionValue.has(key)) {
            scopedRemarksBySelectionValue.set(key, []);
        }

        scopedRemarksBySelectionValue.get(key).push({
            id: remark.id,
            remark_value: remark.remark_value,
            created_at: remark.created_at,
            updated_at: remark.updated_at,
        });
    });

    const textMedicineRows = textMedicines.map(({ normalized_value: normalizedMedicineValue, ...medicine }) => ({
        ...medicine,
        remark_suggestions: scopedRemarksBySelectionValue.get(normalizedMedicineValue) || [],
        medical_products: productMasters.medicalProducts.get(medicine.id) || [],
        products: productMasters.products.get(medicine.id) || [],
        radient_pharma_products: productMasters.radientPharmaProducts.get(medicine.id) || [],
        handwritten_product_prices: productMasters.handwrittenProductPrices.get(medicine.id) || [],
    }));
    const textMedicineRemarkRows = textMedicineRemarks.map(({ normalized_value: _normalizedValue, ...remark }) => remark);

    textMedicineRows.forEach((medicine) => {
        const getVariantRemarkSuggestions = (variantLabel) => (
            scopedRemarksBySelectionValue.get(
                normalizeMasterValue(`${medicine.medicine_value} - ${variantLabel || ''}`)
            ) || []
        );

        medicine.medical_products = (medicine.medical_products || []).map((product) => ({
            ...product,
            remark_suggestions: getVariantRemarkSuggestions(
                product.packing || product.size_or_weight || product.product_name || product.category || 'N/A'
            ),
        }));
        medicine.products = (medicine.products || []).map((product) => ({
            ...product,
            remark_suggestions: getVariantRemarkSuggestions(product.packing || 'N/A'),
        }));
        medicine.radient_pharma_products = (medicine.radient_pharma_products || []).map((product) => ({
            ...product,
            remark_suggestions: getVariantRemarkSuggestions(product.net_weight_or_size || 'N/A'),
        }));
        medicine.handwritten_product_prices = (medicine.handwritten_product_prices || []).map((product) => ({
            ...product,
            remark_suggestions: getVariantRemarkSuggestions(product.product_name || product.category || 'N/A'),
        }));
    });
    const labTestRows = labTests.map(({ normalized_test_name: _normalizedTestName, ...test }) => test);

    return res.status(200).json({
        success: true,
        message: 'Doctor text medicine masters fetched successfully',
        data: {
            text_medicines: textMedicineRows,
            text_medicine_remarks: textMedicineRemarkRows,
            lab_tests: labTestRows,
        },
        meta: {
            total_text_medicines: textMedicineRows.length,
            total_text_medicine_remarks: textMedicineRemarkRows.length,
            total_lab_tests: labTestRows.length,
            total_medical_products: textMedicineRows.reduce((sum, medicine) => sum + medicine.medical_products.length, 0),
            total_products: textMedicineRows.reduce((sum, medicine) => sum + medicine.products.length, 0),
            total_radient_pharma_products: textMedicineRows.reduce((sum, medicine) => sum + medicine.radient_pharma_products.length, 0),
            total_handwritten_product_prices: textMedicineRows.reduce((sum, medicine) => sum + medicine.handwritten_product_prices.length, 0),
        },
    });
});

module.exports = {
    getDoctorDashboard,
    listPatientsForDoctor,
    getDoctorReports,
    getDoctorTextMedicineMasters,
};
