const crypto = require('crypto');
const AppError = require('../../utils/AppError');

const formatDate = value => new Date(value).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
const positiveId = value => Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : null;
const normalizePhone = value => {
    let digits = String(value || '').replace(/[\s()+-]/g, '');
    if (/^\d{10}$/.test(digits)) digits = `91${digits}`;
    if (!/^[1-9]\d{10,14}$/.test(digits)) throw new AppError('Enter a valid WhatsApp number with country code', 400);
    return digits;
};
const buildDocumentModel = (bill, patient, options = {}) => {
    const kind = options.kind || 'BILL';
    const language = options.language || 'en';
    if (!['en', 'hi'].includes(language)) throw new AppError('Select English or Hindi', 400);
    const labels = language === 'hi' ? { title: kind === 'RECEIPT' ? 'भुगतान रसीद' : 'दवा / जाँच बिल', item: kind === 'RECEIPT' ? 'भुगतान / बिल' : 'विवरण', qty: kind === 'RECEIPT' ? 'माध्यम' : 'मात्रा', amount: 'राशि', bill: 'बिल', date: 'दिनांक', patient: 'मरीज', reg: 'रजिस्ट्रेशन नंबर' } : { title: kind === 'RECEIPT' ? 'PAYMENT RECEIPT' : 'MEDICINE / TEST BILL', item: kind === 'RECEIPT' ? 'Collection / bill' : 'Item', qty: kind === 'RECEIPT' ? 'Mode' : 'Qty', amount: 'Amount', bill: 'Bill', date: 'Date', patient: 'Patient', reg: 'Reg. No.' };
    if (!['BILL', 'RECEIPT'].includes(kind)) throw new AppError('Select Bill or Payment Receipt', 400);
    if (String(bill.status).toUpperCase() !== 'ACTIVE') throw new AppError('Only active bills can be shared', 409);
    const paymentIds = options.payment_ids || [];
    if (!Array.isArray(paymentIds) || paymentIds.length > 100 || paymentIds.some(id => !positiveId(id))) throw new AppError('Invalid payment selection', 400);
    const available = [...(bill.payments || []), ...(bill.previous_pending_settlements || [])].filter(p => String(p.status).toUpperCase() === 'SUCCESS');
    const unique = [...new Map(available.map(p => [Number(p.payment_id || p.id), p])).values()];
    const selected = unique.filter(p => paymentIds.map(Number).includes(Number(p.payment_id || p.id)));
    if (kind === 'RECEIPT' && (!selected.length || selected.length !== new Set(paymentIds.map(Number)).size)) throw new AppError('Selected payments are unavailable for this bill', 409);
    const lines = kind === 'RECEIPT'
        ? selected.map(p => ({ name: `${p.bill_number || bill.bill_number} - ${formatDate(p.collected_at || p.created_at)}`, mode: p.payment_mode, amount: p.amount }))
        : (bill.items || []).map(item => ({ name: item.item_name, quantity: item.quantity, amount: item.amount, type: item.item_type }));
    const received = selected.reduce((sum, p) => sum + Number(p.amount || 0), 0);
    const dateValue = kind === 'RECEIPT' ? selected[0].collected_at || selected[0].created_at : bill.created_at;
    const model = {
        kind, language, labels, bill_id: bill.bill_id, bill_number: bill.bill_number,
        filename: `${kind === 'RECEIPT' ? 'Receipt' : 'Bill'}-${String(bill.bill_number).replace(/[^\w-]/g, '-')}.pdf`,
        patient_name: patient.display_name || bill.patient_full_name || patient.full_name,
        patient_uuid: patient.uuid, branch_name: bill.branch_name, branch_address: bill.branch_address,
        date: formatDate(dateValue), lines,
        totals: kind === 'RECEIPT' ? [['Total received', received]] : [
            ['Gross bill', bill.gross_amount ?? bill.total_amount], ['Discount', bill.discount_amount],
            ['Net bill', bill.total_amount], ['Received for this bill', bill.paid_amount], ['Pending on this bill', bill.pending_amount],
        ],
    };
    if (language === 'hi') {
        const translations = { 'Total received': 'कुल प्राप्त राशि', 'Gross bill': 'कुल बिल', Discount: 'छूट', 'Net bill': 'शुद्ध बिल', 'Received for this bill': 'इस बिल की प्राप्त राशि', 'Pending on this bill': 'इस बिल की बकाया राशि' };
        model.totals = model.totals.map(([label, amount]) => [translations[label] || label, amount]);
    }
    model.fingerprint = crypto.createHash('sha256').update(JSON.stringify(model)).digest('hex');
    return model;
};
module.exports = { buildDocumentModel, positiveId, normalizePhone };
