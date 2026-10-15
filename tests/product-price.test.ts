// tests/product-price.test.ts
// Prices recorded ONCE, in Business Information (db/z-product-pricing.sql, src/utils/product-price.ts),
// and reused by every assistant's prompt, the website's products section and Stripe checkout.
//
// Run:  npx tsx tests/product-price.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buyablePence, cleanPrice, formatPounds, poundsToPence, priceDisplay, priceFromText } from '../src/utils/product-price';
import { productFields } from '../netlify/functions/org-products';

let passed = 0;
let total = 0;
function check(name: string, fn: () => void): void {
    total++;
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8');

console.log('\nStructured prices');

check('pounds typed any reasonable way become pence; nonsense does not', () => {
    assert.strictEqual(poundsToPence('24'), 2400);
    assert.strictEqual(poundsToPence('£24.50'), 2450);
    assert.strictEqual(poundsToPence('1,200'), 120000);
    assert.strictEqual(poundsToPence('24.555'), null);
    assert.strictEqual(poundsToPence('twenty'), null);
    assert.strictEqual(poundsToPence(''), null);
    assert.strictEqual(poundsToPence(24.5), 2450, 'a number is pounds too, never pence');
    assert.strictEqual(formatPounds(2450), '£24.50');
    assert.strictEqual(formatPounds(120000), '£1,200');
});

check('the displayed price is derived from the structure — the wording every assistant quotes', () => {
    assert.strictEqual(priceDisplay({ priceType: 'fixed', priceAmount: 2400, priceUnit: 'per hour' }), '£24 per hour');
    assert.strictEqual(priceDisplay({ priceType: 'from', priceAmount: 45000, priceUnit: null }), 'from £450');
    assert.strictEqual(priceDisplay({ priceType: 'on_request', priceAmount: null, priceUnit: null }), 'Price on request');
    assert.strictEqual(priceDisplay({ priceType: 'text', priceAmount: null, priceUnit: null, priceText: '£15 a month, first month free' }), '£15 a month, first month free');
    assert.strictEqual(priceDisplay({ priceType: null, priceAmount: null, priceUnit: null }), null);
});

check('only a fixed price of at least 30p can be bought online', () => {
    assert.strictEqual(buyablePence({ priceType: 'fixed', priceAmount: 2400 }), 2400);
    assert.strictEqual(buyablePence({ priceType: 'fixed', priceAmount: 10 }), null);
    assert.strictEqual(buyablePence({ priceType: 'from', priceAmount: 2400 }), null);
    assert.strictEqual(buyablePence({ priceType: 'text', priceAmount: null }), null);
});

check('a save is checked, and stores the structure AND the displayed wording', () => {
    assert.deepStrictEqual(cleanPrice({ priceType: 'fixed', priceAmount: '24.50', priceUnit: ' per  kg ' }), { priceType: 'fixed', priceAmount: 2450, priceUnit: 'per kg', price: '£24.50 per kg' });
    assert.ok('error' in cleanPrice({ priceType: 'fixed', priceAmount: 'abc' }));
    assert.ok('error' in cleanPrice({ priceType: 'text', price: '  ' }));
    assert.ok('error' in cleanPrice({ priceType: 'discounted' }));
    assert.deepStrictEqual(cleanPrice({ priceType: '' }), { priceType: null, priceAmount: null, priceUnit: null, price: null });
});

check('an older written price is read into the structure where simple, else kept as their words', () => {
    assert.deepStrictEqual(priceFromText('£29'), { priceType: 'fixed', priceAmount: 2900, priceUnit: null });
    assert.deepStrictEqual(priceFromText('from £450'), { priceType: 'from', priceAmount: 45000, priceUnit: null });
    assert.deepStrictEqual(priceFromText('£15/month'), { priceType: 'text', priceAmount: null, priceUnit: null, priceText: '£15/month' });
    const v = productFields({ name: 'Kit', price: 'from £450' }, false);
    assert.ok('values' in v && v.values.priceType === 'from' && v.values.price === 'from £450');
});

check('the products API: duration for services, a picture checked as the workspace\'s own', () => {
    assert.ok('error' in productFields({ name: 'Cut', durationMinutes: 0 }, false));
    const ok = productFields({ name: 'Cut', kind: 'service', durationMinutes: 45, priceType: 'fixed', priceAmount: 55 }, false);
    assert.ok('values' in ok && ok.values.durationMinutes === 45 && ok.values.priceAmount === 5500);
    const fn = read('netlify/functions/org-products.ts');
    assert.ok(fn.includes('async function pictureIsOurs') && fn.includes('eq(contentAssets.organisationId, orgId)'));
    assert.strictEqual((fn.match(/pictureIsOurs\(db, orgId,/g) || []).length, 2, 'checked on add and on edit');
});

check('the migration adds the structure, keeps old prices as words, and reads the simple ones', () => {
    const sql = read('db/z-product-pricing.sql');
    for (const c of ['price_type', 'price_amount', 'price_unit', 'duration_minutes', 'image_asset_id']) assert.ok(sql.includes(`ADD COLUMN IF NOT EXISTS ${c}`), c);
    assert.ok(sql.includes("SET price_type = 'text'") && sql.includes("WHERE price_type IS NULL"));
    assert.ok(read('db/schema.ts').includes('priceAmount: integer("price_amount")'));
    const ui = read('assets.html');
    assert.ok(ui.includes('function priceFieldsHtml(v)') && ui.includes("opt('fixed', 'A fixed price')") && ui.includes('This is the one place prices live'));
});

console.log(`\n${passed}/${total} passed`);
