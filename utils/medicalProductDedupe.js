const normalizeBaseValue = (value) => String(value || '').trim().toLowerCase();

const normalizeProductVariantValue = (value) => {
    let normalized = normalizeBaseValue(value);
    if (!normalized) {
        return '';
    }

    normalized = normalized
        .replace(/[.,]/g, ' ')
        .replace(/([0-9])([a-z])/g, '$1 $2')
        .replace(/([a-z])([0-9])/g, '$1 $2')
        .replace(/\b(tablets?|tabs?)\b/g, 'tab')
        .replace(/\b(capsules?|caps?)\b/g, 'cap')
        .replace(/\b(drops?)\b/g, 'drop')
        .replace(/\b(bottles?|btls?)\b/g, 'bottle')
        .replace(/\b(pills?)\b/g, 'pill')
        .replace(/\b(mls?|m\s*l)\b/g, 'ml')
        .replace(/\b(gms?|grams?|g\s*m)\b/g, 'gm')
        .replace(/\s+/g, ' ')
        .trim();

    return normalized;
};

const normalizeProductNameValue = (value) => normalizeBaseValue(value).replace(/\s+/g, ' ');

const buildMedicalProductIdentityKey = (product) => [
    normalizeProductNameValue(product?.normalized_product_name || product?.product_name),
    normalizeProductVariantValue(product?.packing),
    normalizeProductVariantValue(product?.size_or_weight),
].join('|');

const hasSameMedicalProductIdentity = (left, right) =>
    buildMedicalProductIdentityKey(left) === buildMedicalProductIdentityKey(right);

module.exports = {
    normalizeProductVariantValue,
    normalizeProductNameValue,
    buildMedicalProductIdentityKey,
    hasSameMedicalProductIdentity,
};
