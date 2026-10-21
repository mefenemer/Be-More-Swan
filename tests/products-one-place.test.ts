// tests/products-one-place.test.ts
// Products and prices live in ONE place — Business Information ▸ Products & Services (owner,
// 2026-10-21). The Creative Brief and the social onboarding form used to keep their own free-text
// box (service_offerings), which drifted: £99 there, £69 in the catalogue, and every post warned.
// Run:  npx tsx tests/products-one-place.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { NO_PRODUCTS_BLOCK, offeringsText, renderOfferingsLine } from '../src/utils/org-products';
import { splitOfferingNotes } from '../src/utils/offerings-import';
import { WAND_REWRITABLE_FIELDS } from '../src/config/goal-metrics';
import { briefLines } from '../src/utils/autonomous-draft-brief';

let passed = 0;
function check(name: string, fn: () => void) { fn(); console.log(`  ✓ ${name}`); passed++; }
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

check('the catalogue wins; old notes only while it is empty, and say so', () => {
    const cat = [{ kind: 'product', name: 'The Busywork Buster', price: '£69 a month' }];
    assert.strictEqual(offeringsText(cat, 'Tier 2 £99/mo'), 'The Busywork Buster (£69 a month)');
    assert.ok(offeringsText([], 'Tier 2 £99/mo').startsWith('Tier 2 £99/mo (older notes'));
    assert.strictEqual(offeringsText([], ''), '');
    assert.strictEqual(renderOfferingsLine([{ kind: 'service', name: 'Call' }]), 'Call');
});

check('an empty catalogue still tells every assistant where products live', () => {
    assert.ok(NO_PRODUCTS_BLOCK.includes('Business Information ▸ Products & Services'));
    assert.ok(read('src/utils/org-products.ts').includes('renderProductsBlock(products, businessName) ?? NO_PRODUCTS_BLOCK'));
});

check('old notes split into rows the owner checks', () => {
    assert.deepStrictEqual(splitOfferingNotes('1:1 coaching (£500/mo), Free 15-min discovery call, Self-paced course (£199).'), [
        { name: '1:1 coaching', price: '£500/mo', kind: 'service' },
        { name: 'Free 15-min discovery call', price: 'Free', kind: 'service' },
        { name: 'Self-paced course', price: '£199', kind: 'service' },
    ]);
    assert.deepStrictEqual(splitOfferingNotes('- Sourdough loaf: £4.50\n- Croissant @ £2').map((d) => [d.name, d.price]), [['Sourdough loaf', '£4.50'], ['Croissant', '£2']]);
    assert.deepStrictEqual(splitOfferingNotes('The Workflow Saver £29/mo; Busywork Buster — £69/mo').map((d) => d.price), ['£29/mo', '£69/mo']);
    // A comma inside brackets is not a separator.
    assert.strictEqual(splitOfferingNotes('Masterclass (from £60, lunch included)').length, 1);
    assert.deepStrictEqual(splitOfferingNotes(''), []);
});

check('nothing writes the old box any more', () => {
    assert.ok(!('service_offerings' in WAND_REWRITABLE_FIELDS));
    assert.ok(!read('onboarding-social-media.html').includes('service_offerings:'));
    const collect = read('assistants.js');
    assert.ok(!collect.includes("service_offerings: document.getElementById('edit_offerings')"));
    assert.ok(!read('assistant-detail.html').includes('id="edit_offerings"'));
    // The only write left is clearing it, after a move or on request.
    assert.ok(collect.includes("service_offerings: '' };"));
});

check('every reader goes through the catalogue', () => {
    for (const f of ['netlify/functions/social-auto-responder.ts', 'netlify/functions/schedule-conversion-posts.ts',
        'netlify/functions/process-content-jobs.ts', 'netlify/functions/generate-profile-bio.ts', 'netlify/functions/goal-ai.ts',
        'netlify/functions/autonomous-media-suggestions.ts']) {
        assert.ok(read(f).includes('loadOfferingsText('), f);
    }
    // The autonomous brief takes the caller's catalogue line over the old box.
    assert.deepStrictEqual(briefLines({ name: 'X', offerings: 'Kit (£5)' }, { service_offerings: 'old £9' }), ['Services and offers: Kit (£5)']);
});

check('the onboarding form and the brief save through the products endpoint', () => {
    assert.ok(read('onboarding-social-media.html').includes("var API = '/.netlify/functions/org-products'"));
    assert.ok(read('assistants.js').includes("JSON.stringify({ action: 'split_notes', text: _offeringsNotes })"));
    assert.ok(read('netlify/functions/org-products.ts').includes("body.action === 'split_notes'"));
});

console.log(`\n${passed} passed, 0 failed\n`);
