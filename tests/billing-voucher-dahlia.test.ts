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
import { summariseDiscount, couponOf, DISCOUNT_EXPANDS, renewalDiscountNote, renewalVoucherDetails } from '../src/utils/billing-doc';

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

console.log('\nThe renewal reminder states the amount actually charged');

check('the reminder previews the next invoice instead of quoting the list price', () => {
    const rr = read('netlify/functions/renewal-reminder.ts');
    assert.ok(/stripe\.invoices\.createPreview\(\{ subscription: sub\.id/.test(rr), 'no invoice preview — the amount would be the list price');
    assert.ok(/preview\.amount_due/.test(rr));
    assert.ok(/discount_note: discountNote/.test(rr));
});

check('the note names the discount, says when it ends, and warns when it has run out', () => {
    const v = summariseDiscount([{ promotion_code: { code: 'FOUNDER30' }, source: { coupon: founder } }], 2900, 'gbp')!;
    const ending = { ...v, endsAt: '2027-07-30T00:00:00.000Z' };
    assert.strictEqual(renewalDiscountNote(ending, ending), ' — that includes your FOUNDER30 discount (30% off, until July 2027)');
    assert.strictEqual(renewalDiscountNote(null, v), ' — your FOUNDER30 discount has ended, so this is the full price');
    assert.strictEqual(renewalDiscountNote(null, null), '');
});

check('discount_note is still sent and declared, for admin-edited templates that use it', () => {
    assert.ok(/discount_note: discountNote/.test(read('netlify/functions/renewal-reminder.ts')));
    assert.ok(/key: 'billing\.discount_note'/.test(read('src/utils/email-template.ts')), 'the variable is not declared for the Comms editor');
});

// A customer on a 100% voucher (2026-10-20) read "renews in 14 days" with no date, no plan and no
// word on the voucher, and asked for an "extension". The reminder now says all three.
console.log('\nThe renewal reminder names the date, the plan and the voucher');

const sarahLike = { name: '12 Month Free Coupon', percent_off: 100, duration: 'repeating', duration_in_months: 12 };

check('a 100% voucher applied directly (no code) is described in full', () => {
    const v = { ...summariseDiscount([{ source: { coupon: sarahLike } }], 7900, 'gbp')!, endsAt: '2027-10-19T17:00:00.000Z' };
    assert.strictEqual(renewalVoucherDetails(v, v, 'month'),
        'Your voucher: 12 Month Free Coupon, 100% off for 12 months (until 19 October 2027). It saves you £79.00 on this renewal. After 19 October 2027, your plan renews at the full price of £79.00/month.');
});

check('a code, a once-only and a forever voucher each read right', () => {
    const v = summariseDiscount([{ promotion_code: { code: 'FOUNDER30' }, source: { coupon: founder } }], 2900, 'gbp')!;
    assert.strictEqual(renewalVoucherDetails(v, v, 'month'), 'Your voucher: Founding member (code FOUNDER30), 30% off for 12 months. It saves you £8.70 on this renewal.');
    const once = summariseDiscount([{ source: { coupon: { percent_off: 100, duration: 'once' } } }], 2900, 'gbp')!;
    assert.strictEqual(renewalVoucherDetails(once, once, 'month'), 'Your voucher: 100% off. It saves you £29.00 on this renewal. It applies to this renewal only; after that your plan renews at the full price of £29.00/month.');
    const forever = summariseDiscount([{ promotion_code: { code: 'DDREOG55' }, source: { coupon: { percent_off: 100, duration: 'forever' } } }], 2900, 'gbp')!;
    assert.match(renewalVoucherDetails(forever, forever, 'year'), /^Your voucher: code DDREOG55, 100% off\. .* It lasts for as long as you keep this subscription\.$/);
});

check('an ended voucher says so, and no voucher says nothing', () => {
    const v = summariseDiscount([{ promotion_code: { code: 'FOUNDER30' }, source: { coupon: founder } }], 2900, 'gbp')!;
    assert.strictEqual(renewalVoucherDetails(null, v, 'month'), 'Your voucher (Founding member (code FOUNDER30)) has ended, so this renewal is at the full price.');
    assert.strictEqual(renewalVoucherDetails(null, null, 'month'), '');
});

check('the reminder sends the date, plan and voucher, and the default template shows them', () => {
    const rr = read('netlify/functions/renewal-reminder.ts');
    assert.ok(/renewal_date: renewalDate/.test(rr), 'the renewal date is worked out but never sent');
    assert.ok(/plan_name: \(plan\.planName/.test(rr), 'the plan name is never sent');
    assert.ok(/voucher_details: voucherDetails/.test(rr));
    const cat = read('src/utils/email-templates-catalog.ts');
    const i = cat.indexOf("triggerKey: 'renewal_reminder'");
    assert.ok(i >= 0);
    const entry = cat.slice(i, cat.indexOf('triggerKey:', i + 1));
    assert.ok(/renews on \{\{billing\.renewal_date/.test(entry), 'subject has no date');
    assert.ok(/<strong>\{\{billing\.renewal_date/.test(entry), 'body has no date');
    assert.ok(/\{\{billing\.voucher_details\}\}/.test(entry), 'body has no voucher paragraph');
    const vars = read('src/utils/email-template.ts');
    assert.ok(/key: 'billing\.renewal_date'/.test(vars) && /key: 'billing\.voucher_details'/.test(vars), 'new variables not declared for the Comms editor');
});

console.log('\nThe in-app plan picker reuses one Stripe price per plan');

check('a GBP monthly plan with no configured price reuses the lookup-key price checkout.html uses', () => {
    const ci = read('netlify/functions/create-plan-checkout-intent.ts');
    assert.ok(/planPrice\?\.stripePriceId\s*\?\? \(billingCycle === 'monthly' && priceCurrency === 'gbp' \? await resolveMonthlyPriceId\(stripe, plan\)/.test(ci),
        'the plan picker would mint a one-off Stripe price on every checkout');
});

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
