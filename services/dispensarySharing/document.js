const PDFDocument = require('pdfkit');
const path = require('path');
const money = value => `Rs. ${Number(value || 0).toFixed(2)}`;

const renderDispensaryDocument = model => new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 42, info: { Title: model.filename } });
    const chunks = [];
    doc.on('data', chunk => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.font(process.env.DISPENSARY_PDF_FONT_PATH || path.join(__dirname, '../../assets/fonts/NotoSansDevanagari.ttf'));
    const text = (value, size = 10, color = '#374151') => {
        doc.fontSize(size).fillColor(color).text(String(value || ''), { width: 510 });
    };
    text("Dr. Trivedi's Homeopathy Clinic", 19, '#2d8789');
    text(model.branch_name, 11);
    text(model.branch_address, 9);
    doc.moveDown();
    text(model.labels?.title || (model.kind === 'RECEIPT' ? 'PAYMENT RECEIPT' : 'MEDICINE / TEST BILL'), 15, '#1f2937');
    text(`${model.labels?.bill || 'Bill'}: ${model.bill_number}    ${model.labels?.date || 'Date'}: ${model.date}`, 10);
    text(`${model.labels?.patient || 'Patient'}: ${model.patient_name}`, 11);
    text(`${model.labels?.reg || 'Reg. No.'}: ${model.patient_uuid}`, 11, '#2d8789');
    doc.moveDown();
    const heading = () => {
        const y = doc.y;
        doc.rect(42, y, 511, 25).fill('#edf6f5');
        doc.fillColor('#2d8789').fontSize(10).text(model.labels?.item || (model.kind === 'RECEIPT' ? 'Collection / bill' : 'Item'), 50, y + 8, { width: 325 });
        doc.text(model.labels?.qty || (model.kind === 'RECEIPT' ? 'Mode' : 'Qty'), 380, y + 8, { width: 45 });
        doc.text(model.labels?.amount || 'Amount', 430, y + 8, { width: 113, align: 'right' });
        doc.y = y + 32;
    };
    heading();
    for (const item of model.lines) {
        const description = String(item.name || '');
        const height = Math.max(27, doc.fontSize(10).heightOfString(description, { width: 315 }) + 13);
        if (doc.y + height > 750) { doc.addPage(); heading(); }
        const y = doc.y;
        doc.fillColor(item.type === 'TEST' ? '#b45309' : '#374151').text(description, 50, y, { width: 315 });
        doc.text(String(item.quantity ?? item.mode ?? ''), 380, y, { width: 45 });
        doc.text(money(item.amount), 430, y, { width: 113, align: 'right' });
        doc.moveTo(42, y + height - 6).lineTo(553, y + height - 6).strokeColor('#e5e7eb').stroke();
        doc.y = y + height;
    }
    if (doc.y > 650) doc.addPage();
    doc.x = 42;
    doc.moveDown();
    for (const [label, amount] of model.totals) text(`${label}: ${money(amount)}`, 12, ['Net bill', 'Total received', 'शुद्ध बिल', 'कुल प्राप्त राशि'].includes(label) ? '#2d8789' : '#374151');
    doc.moveDown();
    text('Generated from saved clinic records. This document does not create a new bill or consultation.', 8, '#6b7280');
    doc.end();
});
module.exports = { renderDispensaryDocument };
