require('dotenv').config();
const { buildDerivedLiveQueueView } = require('./services/liveQueueService');

// Create mock queue items for testing all the queue buckets and ordering rules
const mockQueueItems = [
    {
        appointment_id: 101,
        queue_status: 'IN_PROGRESS',
        token_number: 3,
        checked_in_at: '2026-06-02 10:00:00',
        actual_started_at: '2026-06-02 10:05:00',
        planned_start_at: '2026-06-02 10:30:00'
    },
    {
        appointment_id: 102,
        queue_status: 'WAITING',
        actual_called_at: '2026-06-02 10:10:00',
        token_number: 4,
        checked_in_at: '2026-06-02 09:55:00',
        planned_start_at: '2026-06-02 10:45:00'
    },
    {
        appointment_id: 103,
        queue_status: 'CHECKED_IN',
        token_number: 1,
        checked_in_at: '2026-06-02 09:45:00',
        arrival_sequence: 1,
        planned_start_at: '2026-06-02 10:00:00' // Arrived before slot (09:45 <= 10:00) -> Slot Protected!
    },
    {
        appointment_id: 104,
        queue_status: 'CHECKED_IN',
        token_number: 2,
        checked_in_at: '2026-06-02 10:15:00',
        arrival_sequence: 2,
        planned_start_at: '2026-06-02 10:00:00' // Arrived after slot (10:15 > 10:00) -> No Slot Protection.
    },
    {
        appointment_id: 105,
        queue_status: 'BOOKED',
        token_number: 5,
        planned_start_at: '2026-06-02 11:00:00' // Not Arrived
    }
];

async function run() {
    console.log("Executing buildDerivedLiveQueueView with Mock Data...\n");

    const result = buildDerivedLiveQueueView({
        queueItems: mockQueueItems,
        currentRunningAppointmentId: 101
    });

    console.log("--- DERIVED VIEW RESULT ---");
    console.log(JSON.stringify(result, null, 2));
    console.log("---------------------------\n");
}

run();
