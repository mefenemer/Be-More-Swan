// tests/product-dietary.test.ts
// Two follow-ups: dietary markers on products (product-dietary.ts → menus and assistants), and the
// chat approving or declining reviews customers sent in (a review_decisions card, GUI–chat parity).
//
// Run:  npx tsx tests/product-dietary.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanAllergens, cleanDietary, dietaryKey, dietaryMarks, dietaryWords } from '../src/utils/product-dietary';
import { renderProductsBlock } from '../src/utils/org-products';
import { normaliseSiteDefinition } from '../src/utils/site-definition';
import { renderSitePage, type SiteRenderProduct } from '../src/utils/site-render';

let passed = 0;
let total = 0;
function check(name: string, fn: () => void): void {
    total++;
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8');

console.log('\nDietary markers');

check('only known markers, once each, in a fixed order; vegan says vegetarian already', () => {
    assert.deepStrictEqual(cleanDietary(['spicy', 'vegan', 'vegetarian', 'keto', 'vegan', 'gluten_free']), ['vegan', 'gluten_free', 'spicy']);
    assert.strictEqual(cleanDietary([]), null);
    assert.strictEqual(cleanDietary('vegan'), null);
    assert.strictEqual(cleanAllergens('  Contains:   milk,  egg  '), 'Contains: milk, egg');
    assert.strictEqual(cleanAllergens('   '), null);
});
check('marks for a menu line, the key for only what appears, and words for assistants', () => {
    assert.strictEqual(dietaryMarks(['vegan', 'gluten_free']), 'VG · GF');
    assert.strictEqual(dietaryKey([['vegan'], ['contains_nuts', 'vegan'], null]), 'VG vegan · N contains nuts');
    assert.strictEqual(dietaryWords(['vegetarian', 'dairy_free']), 'vegetarian, dairy-free');
});
check('assistants are told the markers and allergens as the business states them', () => {
    const block = renderProductsBlock([{ kind: 'product', name: 'Mushroom risotto', price: '£14', dietary: ['vegetarian', 'gluten_free'], allergens: 'Contains: milk' }])!;
    assert.ok(block.includes('Dietary (as the business states it): vegetarian, gluten-free'));
    assert.ok(block.includes('Allergens (as the business states it): Contains: milk'));
});
check('a menu shows the marks, the allergen words, a key, and "ask us about allergens"', () => {
    const products: Record<number, SiteRenderProduct> = {
        1: { id: 1, name: 'Mushroom risotto', description: null, price: '£14', buyPence: 1400, imageAssetId: null, dietary: ['vegetarian', 'gluten_free'], allergens: 'Contains: milk' },
        2: { id: 2, name: 'Fish & chips', description: null, price: '£15', buyPence: 1500, imageAssetId: null },
    };
    const def = normaliseSiteDefinition({ settings: { siteName: 'Bistro' }, pages: [{ title: 'Home', slug: '', sections: [{ id: 'm1', type: 'menu', props: { groups: [{ title: 'Mains', productIds: [1, 2] }] } }] }] }).definition;
    const html = renderSitePage(def, '/', { origin: 'https://x', preview: false, reportUrl: '#', creditUrl: null, products }).html;
    assert.ok(html.includes('Mushroom risotto <span class="dm" title="vegetarian, gluten-free">V · GF</span>'));
    assert.ok(html.includes('<p class="md al">Contains: milk</p>'));
    assert.ok(html.includes('V vegetarian · GF gluten-free. Please tell us about any allergies before you order — ask us about allergens.'));
    const plain = renderSitePage(def, '/', { origin: 'https://x', preview: false, reportUrl: '#', creditUrl: null, products: { 2: products[2] } }).html;
    assert.ok(!plain.includes('ask us about allergens'), 'no food note when nothing is marked');
});
check('saved through Business Information; the SQL adds the columns', () => {
    const api = read('netlify/functions/org-products.ts');
    assert.ok(api.includes("if (!partial || has('dietary')) values.dietary = cleanDietary(body.dietary);"));
    const ui = read('assets.html');
    assert.ok(ui.includes('data-op-diet') && ui.includes('id="op-allergens"') && ui.includes("dietary: [...f.querySelectorAll('[data-op-diet]:checked')]"));
    assert.ok(read('db/z-product-dietary.sql').includes('ADD COLUMN IF NOT EXISTS dietary   JSONB'));
});

console.log('\nThe chat and waiting reviews');

check('the chat sees waiting reviews by id and can propose decisions, never burying a genuine one', () => {
    assert.ok(read('src/utils/reviews.ts').includes('Waiting for their approval (sent in by customers; for a review_decisions card)'));
    const chat = read('netlify/functions/chat-orchestrator.ts');
    assert.ok(chat.includes('{"type":"review_decisions"') && chat.includes('never offer to bury a bad review'));
    const card = read('src/components/disruptive-ui-registry.js');
    assert.ok(card.includes("register('review_decisions', renderReviewDecisionsCard)"));
    assert.ok(card.includes("(d.decision === 'approve' || d.reason)"), 'a decline without a reason is dropped');
    const session = read('src/components/chat-session.js');
    assert.ok(session.includes("container.addEventListener('site:reviewDecisions', onReviewDecisions)") && session.includes("body: JSON.stringify({ id: x.reviewId, decision: x.decision })"));
});

console.log(`\n${passed}/${total} passed\n`);
