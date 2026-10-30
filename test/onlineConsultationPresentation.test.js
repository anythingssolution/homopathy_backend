const test = require('node:test');
const assert = require('node:assert/strict');
require('dotenv').config();
const { VISIT_TYPE, getVisitTypeCode, canCreateNextFollowUpForVisitType } = require('../services/followupService');
const { buildSlotTokenPlate } = require('../utils/appointmentTokens');

const plate = (branchId, selectedVisitTypeCode = null) => buildSlotTokenPlate({
    branchId,
    slotId: 1,
    appointmentDate: '2026-11-03',
    slotStartTime: '11:00:00',
    selectedVisitTypeCode,
});

test('renamed and legacy names retain the same visit rules', () => {
    for (const treatmentName of ['Online Consultation', 'Chronic Case Discussion']) {
        assert.equal(getVisitTypeCode({ treatmentName }), VISIT_TYPE.CHRONIC_CASE_DISCUSSION);
    }
    assert.equal(canCreateNextFollowUpForVisitType(VISIT_TYPE.CHRONIC_CASE_DISCUSSION), true);
});

test('online token keeps its duration, colour and reservation rules', () => {
    const selectable = plate(1, VISIT_TYPE.CHRONIC_CASE_DISCUSSION);
    const online = selectable.filter((token) => token.visit_type_code === VISIT_TYPE.CHRONIC_CASE_DISCUSSION);
    assert.equal(selectable.length, 40);
    assert.equal(online.length, 1);
    assert.equal(online[0].visit_type_label, 'Online Consultation');
    assert.equal(online[0].short_label, 'Online');
    assert.equal(online[0].duration_minutes, 14);
    assert.equal(online[0].color_code, '#7C3AED');
    assert.equal(online[0].is_selectable, true);

    const reserved = plate(1, VISIT_TYPE.ACUTE_TREATMENT)[online[0].token_number - 1];
    assert.equal(reserved.is_selectable, false);
    assert.equal(reserved.selection_disabled_reason, 'Reserved for Online Consultation');
    assert.equal(reserved.estimated_start_at, online[0].estimated_start_at);
    assert.equal(reserved.estimated_end_at, online[0].estimated_end_at);
});

test('rename does not add online tokens to branch 2', () => {
    const tokens = plate(2);
    assert.equal(tokens.length, 70);
    assert.equal(tokens.some((token) => token.visit_type_code === VISIT_TYPE.CHRONIC_CASE_DISCUSSION), false);
});
