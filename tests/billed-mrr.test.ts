// tests/billed-mrr.test.ts
// The COGS margin must use what a workspace actually pays, and Check Stripe must show annual
// subscribers on an old price.
//
// WHY THIS EXISTS (2026-10-13): COGS credited every workspace with its plan's LIST price. Three prod
// workspaces on 100%-off comps showed £79–£349 of revenue and a 99–100% margin; founding members on
// 30% off would all have looked more profitable than they are.
//
// Run:  npx tsx tests/billed-mrr.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { billedMonthlyFromSubscription } from '../src/utils/billed-mrr';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

const sub = (unit: number, interval: 'month' | 'year', discounts: unknown[] = []) => ({
    items: { data: [{ quantity: 1, price: { unit_amount: unit, currency: 'gbp', recurring: { interval } } }] },
    discounts,
});
const coupon = (c: Record<string, unknown>, code: string | null = null) => ({ promotion_code: code ? { code } : null, source: { coupon: c } });

console.log('\nWhat a subscription actually bills per month');

check('no discount: the list price', () => {
    assert.deepStrictEqual(billedMonthlyFromSubscription(sub(2900, 'month')), { monthlyGbp: 29, discount: null, interval: 'month' });
});

check('a 100%-off comp bills £0, not £79', () => {
    const r = billedMonthlyFromSubscription(sub(7900, 'month', [coupon({ name: 'Free Access', percent_off: 100, duration: 'forever' }, 'DDREOG55')]));
    assert.strictEqual(r.monthlyGbp, 0);
    assert.strictEqual(r.discount, 'DDREOG55 100% off');
});

check('a founding member on 30% off bills £20.30', () => {
    assert.strictEqual(billedMonthlyFromSubscription(sub(2900, 'month', [coupon({ name: 'Founding member', percent_off: 30, duration: 'repeating' }, 'FOUNDER30')])).monthlyGbp, 20.3);
});

check('an annual plan counts as a twelfth of the year', () => {
    const r = billedMonthlyFromSubscription(sub(27600, 'year'));
    assert.strictEqual(r.monthlyGbp, 23);
    assert.strictEqual(r.interval, 'year');
});

console.log('\nWired in');

check('the COGS dashboard credits each workspace with what Stripe bills, list price only as fallback', () => {
    const api = read('netlify/functions/admin-api.ts');
    const cogs = api.slice(api.indexOf("resource === 'cogs-dashboard'"), api.indexOf("resource === 'cogs-workspace-detail'"));
    assert.ok(/billedMonthlyBySubscription\(/.test(cogs));
    assert.ok(/source: 'stripe'/.test(cogs) && /source: 'list'/.test(cogs) && /source: 'beta'/.test(cogs));
    assert.ok(/mrrSource: plan\?\.source/.test(cogs));
    assert.ok(/Paid \/ month \(GBP\)/.test(read('admin.html')), 'the column still says MRR as if it were list price');
});

check('Check Stripe lists annual subscribers and flags an old price', () => {
    const fn = read('netlify/functions/admin-coupons.ts');
    assert.ok(/recurring\?\.interval === 'year'/.test(fn));
    assert.ok(/onCurrentPrice: !!expectedKey && item\.price\.lookup_key === expectedKey && productId === plan\?\.stripeProductId/.test(fn));
    assert.ok(/Annual subscribers \(\$\{annualList\.length\}\)/.test(read('admin.html')));
});

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
