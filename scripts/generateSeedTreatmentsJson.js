const fs = require('fs');
const path = require('path');

const sourcePath = path.resolve(__dirname, '../../homopathy_frontend/src/data/treatmentsData.ts');
const outputPath = path.resolve(__dirname, '../data/seed-treatments.json');

const PUBLIC_SLUG = {
    acne: 'acne-pimples',
    'bone-disorders': 'bone-related-disorders',
    cervical: 'cervical-spondylitis',
    'mental-health': 'mental-health-issues',
    piles: 'piles-hemorrhoids',
    prostate: 'prostate-issues',
    'joint-muscular-pain': 'joint-and-muscular-pain',
    thyroid: 'thyroid-disorders',
    diarrhea: 'diarrhea-and-dysentery',
    'sexual-health': 'sexual-health-problems',
    anemia: 'anemia-blood-deficiency',
    ent: 'ear-nose-throat-disorders-ent',
    gynecology: 'gynecological-disorders-womens-health-issues',
    pediatrics: 'pediatric-diseases-childrens-health-problems',
    'skin-diseases': 'skin-diseases-dermatological-issues',
    'chronic-diseases': 'chronic-complex-diseases',
    obesity: 'obesity-weight-management',
    'respiratory-issues': 'respiratory-issues-asthma-breathing-difficulty',
};

const source = fs.readFileSync(sourcePath, 'utf8');
const start = source.indexOf('export const treatmentsData');
if (start < 0) {
    throw new Error('treatmentsData not found');
}

const block = source.slice(start);
const objects = [];
const objectRegex = /\{\s*id:\s*"([^"]+)"[\s\S]*?\n  \}/g;
let match;
while ((match = objectRegex.exec(block))) {
    const body = match[0];
    const pick = (key) => {
        const found = body.match(new RegExp(`${key}:\\s*"([\\s\\S]*?)"`));
        return found ? found[1] : '';
    };
    const id = pick('id');
    const remediesMatch = body.match(/remedies:\s*\[([^\]]*)\]/);
    const remedies = remediesMatch
        ? remediesMatch[1]
            .split(',')
            .map((item) => item.trim().replace(/^["']|["']$/g, ''))
            .filter(Boolean)
        : [];
    objects.push({
        slug: PUBLIC_SLUG[id] || id,
        title_en: pick('en'),
        title_hi: pick('hi') || null,
        category: pick('category') || 'Specialty',
        description: pick('description'),
        image_url: pick('image') || null,
        remedies,
        sort_order: objects.length + 1,
        is_active: 1,
    });
}

if (objects.length < 20) {
    throw new Error(`Parsed too few treatments: ${objects.length}`);
}

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(objects, null, 2)}\n`);
console.log(`Wrote ${objects.length} treatments to ${outputPath}`);
