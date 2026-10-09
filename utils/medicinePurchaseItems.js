const partitionMedicinePurchaseItems = (items = []) => {
    const tests = [], medications = [], delivery = [];
    for (const item of items) {
        if (item.item_type === 'TEST') tests.push(item);
        else if (item.item_type === 'DELIVERY' || String(item.item_name || '').trim().toLowerCase() === 'courier charge') delivery.push(item);
        else medications.push(item);
    }
    return { medications, delivery, tests: tests.map((item) => ({
        ...item,
        consultation_test_id: `bill-test-${item.bill_item_id || item.id}`,
        test_name: item.item_name,
        added_by_role: 'MEDICAL',
        dispense_status: 'ACTIVE',
    })) };
};

module.exports = { partitionMedicinePurchaseItems };
