const normalize = (value) => String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');

// Historical prescriptions store product, packing and quantity in display text.
const resolveRepeatMedicineAmount = (medication, products) => {
    const fallback = Number(medication.last_amount) || 0;
    if (medication.medicine_type !== 'TEXT') return fallback;

    let value = String(medication.medicine_value || '').trim();
    let quantity = 1;
    const suffix = value.match(/^(.*?)\s*[*xX]\s*(\d+)$/);
    const prefix = value.match(/^(\d+)\s*[*xX]\s*(.*)$/);
    if (suffix) {
        value = suffix[1].trim();
        quantity = Number(suffix[2]);
    } else if (prefix) {
        value = prefix[2].trim();
        quantity = Number(prefix[1]);
    }
    if (!Number.isInteger(quantity) || quantity < 1) return fallback;

    const normalizedValue = normalize(value);
    const activeProducts = products.filter((product) => Number(product.is_active) === 1);
    // Try the complete name first: some product names themselves contain " - ".
    let candidates = activeProducts.filter((product) => normalize(product.product_name) === normalizedValue);
    if (!candidates.length) {
        candidates = activeProducts.filter((product) => {
            const name = normalize(product.product_name);
            const variant = normalize(product.packing || product.size_or_weight || product.product_name || product.category);
            return name && variant && normalizedValue === `${name} - ${variant}`;
        });
    }
    if (!candidates.length) return fallback;

    const rates = candidates.map((product) => Number(product.mrp_rate || product.price_max || product.price_min || 0));
    if (rates.some((rate) => !Number.isFinite(rate) || rate <= 0)) return fallback;
    if (new Set(rates).size !== 1) return fallback;
    return Number((rates[0] * quantity).toFixed(2));
};

module.exports = { resolveRepeatMedicineAmount };
