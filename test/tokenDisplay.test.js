const test = require('node:test');
const assert = require('node:assert/strict');
require('dotenv').config();
const { decorateTokenFields } = require('../utils/tokenDisplay');

test('extra token exposes its persisted planned time to dashboard consumers', () => {
    const result = decorateTokenFields({
        appointment_id: 5821,
        fk_branch_id: 1,
        fk_slot_id: 1,
        appointment_date: '2026-09-19',
        slot_name: 'Morning Session',
        start_time: '08:00:00',
        token_number: 46,
        current_token_number: 46,
        planned_start_at: new Date(2026, 8, 19, 14, 57, 0),
        planned_end_at: new Date(2026, 8, 19, 15, 1, 30),
    });

    assert.equal(result.template_start_time, '14:57:00');
    assert.equal(result.scheduled_start_time, '14:57:00');
    assert.equal(result.display_token_display, 'M-46');
});

test('base token keeps its configured template time ahead of a persisted plan', () => {
    const result = decorateTokenFields({
        fk_branch_id: 1,
        fk_slot_id: 1,
        appointment_date: '2026-09-19',
        slot_name: 'Morning Session',
        start_time: '08:00:00',
        token_number: 1,
        current_token_number: 1,
        planned_start_at: '2026-09-19 23:59:00',
    });

    assert.notEqual(result.template_start_time, '23:59:00');
    assert.match(result.template_start_time, /^\d{2}:\d{2}(?::\d{2})?$/);
});
