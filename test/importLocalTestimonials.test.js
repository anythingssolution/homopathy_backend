const test = require('node:test');
const assert = require('node:assert/strict');
const archive = require('../data/localTestimonials');
const { importLocalTestimonials } = require('../scripts/importLocalTestimonials');
function fixture(initial = [], failAt = 0) {
    let rows = initial.map(row => ({ ...row })), snapshot;
    let releases = 0;
    return {
        rows: () => rows,
        released: () => releases,
        connection: {
            beginTransaction: async () => { snapshot = rows.map(row => ({ ...row })); },
            commit: async () => {}, rollback: async () => { if (snapshot) rows = snapshot; },
            execute: async (sql, p) => {
                if (sql.includes('GET_LOCK')) return [[{ acquired: 1 }]];
                if (sql.includes('RELEASE_LOCK')) { releases++; return [[{ released: 1 }]]; }
                if (sql.includes('SELECT id')) return [rows.filter(row => row.image_original_key === p[0] || row.image_original_url === p[1] || p.slice(2).includes(row.image_url))];
                if (sql.includes('INSERT INTO')) {
                    if (failAt && rows.length + 1 === failAt) throw new Error('Fixture insert failed');
                    rows.push({ id: rows.length + 1, person_name: p[0], testimonial_text: p[1], image_url: p[2], image_original_url: p[3], image_original_key: p[4], is_active: 1 });
                    return [{ affectedRows: 1 }];
                }
                if (sql.includes('UPDATE')) { Object.assign(rows.find(row => row.id === p[3]), { image_url: p[0], image_original_url: p[1], image_original_key: p[2] }); return [{ affectedRows: 1 }]; }
                throw new Error('Unexpected query');
            },
        },
    };
}
test('preview writes nothing; apply inserts all eleven once and rerun skips them', async () => {
    const f = fixture();
    assert.equal((await importLocalTestimonials(f.connection)).inserted, 11);assert.equal(f.rows().length, 0);
    assert.equal((await importLocalTestimonials(f.connection, { apply: true })).inserted, 11);
    const second = await importLocalTestimonials(f.connection, { apply: true });assert.equal(second.inserted, 0);assert.equal(second.skipped, 11);
    assert.equal(f.rows().length, 11);assert.equal(f.released(), 3);
});
test('legacy image is localized while preserving actual text, name, order and inactive status', async () => {
    const f = fixture([{ id: 42, image_url: archive[0].source_url, person_name: 'Existing name', testimonial_text: 'Actual saved review', sort_order: 99, is_active: 0 }]);
    await importLocalTestimonials(f.connection, { apply: true, items: [archive[0]] });
    assert.equal(f.rows().length, 1);assert.equal(f.rows()[0].image_url, archive[0].image_url);
    assert.equal(f.rows()[0].person_name, 'Existing name');assert.equal(f.rows()[0].testimonial_text, 'Actual saved review');
    assert.equal(f.rows()[0].is_active, 0);assert.equal(f.rows()[0].sort_order, 99);
});
test('failure rolls back all inserts and releases import lock', async () => {
    const f = fixture([], 3);
    await assert.rejects(importLocalTestimonials(f.connection, { apply: true }), /Fixture insert failed/);
    assert.equal(f.rows().length, 0);assert.equal(f.released(), 1);
});
