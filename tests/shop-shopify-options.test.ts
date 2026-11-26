// tests/shop-shopify-options.test.ts
// Bring your Shopify shop across (online shop Phase 2, slice 9; feature request #35, docs/online-shop-review-plan.md
// §12): the feed's variants become OUR options (each its own price, unavailable ones sold out), its description comes
// as plain text, a product read off a page gets the feed's details, and the owner is told stock doesn't come across.
// The save is proven by tests/shop-shopify-options-db.test.ts (CI's rls job).
//
// Run:  npx tsx tests/shop-shopify-options.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { plainDescription, readShopifyFeed, shopifyOptions, FEED_MAX_OPTIONS } from '../src/utils/site-shop-feeds';
import { productFieldsFromImport } from '../src/utils/site-import';

let passed = 0;
let total = 0;
function check(name: string, fn: () => void): void {
    total++;
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const root = join(__dirname, '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

const tee = {
    title: 'Logo T-shirt', handle: 'logo-tee', body_html: '<p>Soft <strong>organic</strong> cotton.</p><ul><li>Unisex fit</li></ul>',
    options: [{ name: 'Size', values: ['S', 'M', 'L'] }],
    variants: [
        { title: 'S', price: '20.00', available: true },
        { title: 'M', price: '20.00', available: false },
        { title: 'L', price: '22.50', available: true },
    ],
    images: [{ src: 'https://cdn.shopify.com/tee.jpg' }],
};
const mug = { title: 'Mug', handle: 'mug', body_html: '', options: [{ name: 'Title', values: ['Default Title'] }], variants: [{ title: 'Default Title', price: '9.00', available: true }], images: [] };

console.log('\nshop-shopify-options');

check('variants → one choice group, each its own price (null = the cheapest), unavailable = sold out', () => {
    assert.deepStrictEqual(shopifyOptions(tee as never), { group: 'Size', options: [
        { label: 'S', price: null, soldOut: false }, { label: 'M', price: null, soldOut: true }, { label: 'L', price: 22.5, soldOut: false },
    ] });
    assert.strictEqual(shopifyOptions(mug as never), null, 'a single "Default Title" variant is no options');
    const two = { ...tee, options: [{ name: 'Size' }, { name: 'Colour' }], variants: [{ title: 'S / Red', price: '20' }, { title: 'S / Blue', price: '20' }] };
    assert.strictEqual(shopifyOptions(two as never)!.group, 'Size / Colour');
    const many = { ...tee, variants: Array.from({ length: FEED_MAX_OPTIONS + 1 }, (_, i) => ({ title: `V${i}`, price: '10' })) };
    assert.strictEqual(shopifyOptions(many as never), null, `more than ${FEED_MAX_OPTIONS} variants keeps "From £x"`);
});

check('the feed: a product with options is priced at its cheapest (buyable); description as plain text; picture and page as before', () => {
    const [t, m] = readShopifyFeed(JSON.stringify({ products: [tee, mug] }), 'https://oldshop.example', 'GBP');
    assert.strictEqual(t.price, '£20.00', 'not "From £20.00": each option carries its own price');
    assert.strictEqual(t.description, 'Soft organic cotton.\nUnisex fit');
    assert.strictEqual(t.options?.options.length, 3);
    assert.deepStrictEqual([t.href, t.image], ['https://oldshop.example/products/logo-tee', 'https://cdn.shopify.com/tee.jpg']);
    const f = productFieldsFromImport(t);
    assert.deepStrictEqual([f.priceType, f.priceAmount], ['fixed', 2000], 'a fixed price, so the options can be bought');
    assert.deepStrictEqual([m.price, m.options, m.description], ['£9.00', null, null]);
    const many = { ...tee, variants: Array.from({ length: FEED_MAX_OPTIONS + 1 }, (_, i) => ({ title: `V${i}`, price: String(10 + i) })) };
    assert.strictEqual(readShopifyFeed(JSON.stringify({ products: [many] }), 'https://o.example', 'GBP')[0].price, 'From £10.00');
});

check('plain description: tags and scripts out, entities decoded, cut at a word within the limit', () => {
    assert.strictEqual(plainDescription('<p>A &amp; B</p><script>alert(1)</script><br>C'), 'A & B\nC');
    assert.strictEqual(plainDescription(''), null);
    const long = plainDescription(`<p>${'word '.repeat(400)}</p>`, 50)!;
    assert.ok(long.length <= 50 && long.endsWith('…'));
});

check('wired: page products get the feed\'s details; the save adds descriptions and options; the owner is told', () => {
    const imp = read('src/utils/site-import.ts');
    assert.ok(imp.includes("return { ...p, description: p.description ?? f.description ?? null, ...(f.options ? { options: f.options, price: f.price ?? p.price } : {}) };"));
    const store = read('src/utils/site-import-store.ts');
    assert.ok(store.includes('description: p.description ? p.description.slice(0, PRODUCT_LIMITS.description) : null,'));
    assert.ok(store.includes("if (!p.options?.options.length || !row || row.priceType !== 'fixed') continue;") && store.includes("stock: o.soldOut ? 0 : ''"));
    assert.ok(read('netlify/functions/sites.ts').includes("came with ${r.withOptions === 1 ? 'its' : 'their'} options"));
    assert.ok(read('src/components/assistant-site-editor.js').includes('data-site-import-options-note>Options (sizes, colours…) come with their own prices'));
    assert.ok(store.includes("stock counts don't come across (the shop's feed hasn't got them)"));
    assert.ok(read('.github/workflows/ci.yml').includes('run: npx tsx tests/shop-shopify-options-db.test.ts'));
});

console.log(`\n${passed}/${total} passed`);
