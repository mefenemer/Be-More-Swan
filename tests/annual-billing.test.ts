// tests/annual-billing.test.ts
// "Pay Annually" (20% off) must charge what the pricing page advertises, sit on the plan's own Stripe
// product, and survive a plan change.
//
// WHY THIS EXISTS (found 2026-10-13):
//   1. pricing.html advertises round(monthly × 0.8) × 12 — £276 for the £29 plan. checkout.html and
//      the promo preview charged monthly × 12 × 0.8 unrounded — £278.40. Only the in-app plan picker
//      matched the page. Three formulas for one price.
//   2. Annual prices were created on a separate "<plan> (Annual)" product; reconciliation identifies
//      a subscription's plan by product, so annual subscribers could not be placed. The in-app picker
//      minted a new product AND price on every annual checkout.
//   3. Upgrades and downgrades always swapped in the MONTHLY price, moving an annual subscriber onto
//      monthly billing and out of their discount.
//
// Run:  npx tsx tests/annual-billing.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { annualAmountGbp, annualLookupKey, resolveAnnualPriceId } from '../src/utils/stripe-price';

let passed = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

(async () => {
    console.log('\nThe annual price is the advertised price');

    await check('£29 / £79 / £349 → £276 / £756 / £3,348 a year, as pricing.html shows', () => {
        assert.strictEqual(annualAmountGbp(29), 276);
        assert.strictEqual(annualAmountGbp(79), 756);
        assert.strictEqual(annualAmountGbp('349.00'), 3348);
    });

    await check('the pricing page still uses the same sum (round the discounted month, then × 12)', () => {
        const page = read('pricing.html');
        assert.ok(/const annual = Math\.round\(m \* 0\.8\)/.test(page) && /annualTotal\[i\] = annual \* 12/.test(page),
            'pricing.html changed its annual sum — change annualAmountGbp with it');
    });

    await check('every path that prices an annual plan uses the shared helper — no private formula left', () => {
        for (const f of ['netlify/functions/create-subscription.ts', 'netlify/functions/validate-promo.ts', 'netlify/functions/create-plan-checkout-intent.ts']) {
            const s = read(f);
            assert.ok(!/\* 12 \* ANNUAL_DISCOUNT|monthlyAmount \* ANNUAL_DISCOUNT/.test(s), `${f} still has its own annual formula`);
        }
        assert.ok(/billingCycle === 'annual' \? annualAmountGbp\(monthlyGbp\)/.test(read('netlify/functions/create-subscription.ts')));
        assert.ok(/annualAmountGbp\(baseGbp\)/.test(read('netlify/functions/validate-promo.ts')));
    });

    console.log('\nOne reusable yearly price, on the plan\'s own product');

    await check('found by lookup key and reused; created once on the plan product, never a "(Annual)" product', async () => {
        const calls: string[] = [];
        let created: Record<string, unknown> | null = null;
        const fake = (hit: boolean) => ({
            prices: {
                list: async (p: { lookup_keys: string[] }) => { calls.push(`list:${p.lookup_keys[0]}`); return { data: hit ? [{ id: 'price_existing' }] : [] }; },
                create: async (p: Record<string, unknown>) => { created = p; return { id: 'price_new' }; },
            },
            products: { create: async () => { calls.push('product'); return { id: 'prod_new' }; } },
        });
        const plan = { tierKey: 'saver', name: 'The Workflow Saver', monthlyPriceGbp: '29.00', stripeProductId: 'prod_saver' };
        assert.strictEqual(await resolveAnnualPriceId(fake(true) as any, plan), 'price_existing');
        assert.deepStrictEqual(calls, ['list:saver_annual_gbp_27600']);
        assert.strictEqual(await resolveAnnualPriceId(fake(false) as any, plan), 'price_new');
        assert.ok(!calls.includes('product'), 'a plan with a product must not get a new one');
        assert.strictEqual((created as any).product, 'prod_saver');
        assert.strictEqual((created as any).unit_amount, 27600);
        assert.deepStrictEqual((created as any).recurring, { interval: 'year' });
        assert.strictEqual(annualLookupKey('saver', 27600), 'saver_annual_gbp_27600');
    });

    await check('neither checkout creates an "(Annual)" product or an inline yearly price for GBP any more', () => {
        assert.ok(!/\(Annual\)`/.test(read('netlify/functions/create-subscription.ts')));
        assert.ok(/stripePriceId = await resolveAnnualPriceId\(stripe, masterPlan\)/.test(read('netlify/functions/create-subscription.ts')));
        const ci = read('netlify/functions/create-plan-checkout-intent.ts');
        assert.ok(/billingCycle === 'annual' && priceCurrency === 'gbp'\) \{[\s\S]{0,300}?lineItem = \{ price: await resolveAnnualPriceId\(stripe, plan\)/.test(ci));
    });

    console.log('\nA plan change keeps the billing period');

    await check('upgrade and downgrade resolve the target price for the CURRENT interval', () => {
        const up = read('netlify/functions/billing-upgrade.ts');
        assert.ok(!/resolveMonthlyPriceId\(stripe, targetMp\)/.test(up), 'upgrade still forces the monthly price');
        assert.ok(/recurring\?\.interval === 'year' \? 'year' : 'month'/.test(up));
        assert.strictEqual(up.match(/targetPriceId = await targetPriceFor\(sub\)/g)?.length, 2, 'preview and execute must both use it');
        const down = read('netlify/functions/billing-downgrade.ts');
        assert.ok(!/resolveMonthlyPriceId\(stripe, targetMp\)/.test(down), 'downgrade still forces the monthly price');
        assert.ok(/resolvePriceIdForInterval\(stripe, targetMp, currentItem\.price\?\.recurring\?\.interval === 'year'/.test(down));
    });

    console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
})();
