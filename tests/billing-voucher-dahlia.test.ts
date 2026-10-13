// tests/billing-voucher-dahlia.test.ts
// A coupon must show on our invoices, receipts and the billing page.
//
// WHY THIS EXISTS. In the Stripe API version this app pins (2026-05-27.dahlia) a Discount carries its
// coupon at `source.coupon`, not `coupon`. summariseDiscount read `d.coupon`, found nothing, and
// returned null for every discount — so a customer on 30% off was charged correctly by Stripe but
// saw no voucher line anywhere in Be More Swan. Found 2026-10-13 while building the Coupons screen.
//
// Run:  npx tsx tests/billing-voucher-dahlia.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { summariseDiscount, couponOf, DISCOUNT_EXPANDS } from '../src/utils/billing-doc';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

const founder = { name: 'Founding member', percent_off: 30, duration: 'repeating', duration_in_months: 12 };

console.log('\nVoucher lines read the coupon where this API version puts it');

check('a dahlia-shaped discount (source.coupon) produces the voucher line', () => {
    const v = summariseDiscount([{ promotion_code: { code: 'FOUNDER30' }, source: { type: 'coupon', coupon: founder } }], 2900, 'gbp');
    assert.ok(v, 'no voucher — the discount was dropped');
    assert.strictEqual(v!.label, '30% off');
    assert.deepStrictEqual(v!.codes, ['FOUNDER30']);
    assert.strictEqual(v!.netAmount, 20.3);
    assert.strictEqual(v!.durationInMonths, 12);
});

check('the older shape (coupon on the discount) still works', () => {
    assert.ok(summariseDiscount([{ coupon: founder }], 2900, 'gbp'));
});

check('an UNEXPANDED coupon (just an id) is not mistaken for one — so every read must expand it', () => {
    assert.strictEqual(couponOf({ source: { coupon: 'co_123' } }), null);
    assert.ok(DISCOUNT_EXPANDS.includes('discounts.source.coupon'));
});

check('every Stripe read feeding a voucher line expands the coupon', () => {
    const doc = read('src/utils/billing-doc.ts');
    assert.ok(/invoices\.retrieve\(stripeInvoiceId, \{ expand: DISCOUNT_EXPANDS \}\)/.test(doc), 'the printable invoice/receipt read');
    const data = read('netlify/functions/billing-data.ts');
    const expands = data.match(/'data\.discounts\.promotion_code'/g)?.length ?? 0;
    const coupon = data.match(/'data\.discounts\.source\.coupon'/g)?.length ?? 0;
    assert.ok(expands > 0 && coupon === expands, 'the billing page reads discounts without expanding source.coupon');
});

check('nothing reads the removed d.coupon field directly', () => {
    const doc = read('src/utils/billing-doc.ts').replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '');
    assert.ok(!/const c = d\.coupon;/.test(doc));
});

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
