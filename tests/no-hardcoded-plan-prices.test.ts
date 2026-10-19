// tests/no-hardcoded-plan-prices.test.ts
// Plan prices come from master data only (owner, 2026-10-19).
//
// WHY THIS EXISTS. The Busywork Buster moved from £79 to £69 in Admin ▸ Master Data ▸ Plans, and
// "£79" carried on in five places that had typed it: the pricing page's fallbacks and its
// US$/€/A$/C$ switcher (checkout only ever charges in pounds), the homepage, the Billing page's
// trial buttons, the trial email and the help article. What can break again without anything
// failing:
//
//   · someone types a price back into a page "as a fallback"
//   · the email or help-article tokens stop being filled
//   · the page's annual price stops coming from the helper checkout charges with
//
// Run:  npx tsx tests/no-hardcoded-plan-prices.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fillPlanPriceTokens, formatGbp } from '../src/utils/plan-price-tokens';
import { getTemplateDefault } from '../src/utils/email-templates-catalog';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f: string) => readFileSync(join(root, f), 'utf8');
/** Source with comments removed, so a comment that mentions an old price does not count. */
const code = (s: string) => s.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}`); throw err; }
}

console.log('no-hardcoded-plan-prices');

check('the pricing page carries no plan price and no currency switcher', () => {
    const src = code(read('pricing.html'));
    for (const banned of ['CURRENCY_CONFIG', 'BILLING_CONFIG', 'setCurrency', 'currency-selector']) {
        assert.ok(!src.includes(banned), banned);
    }
    // The only £ amounts left are the illustrative market comparison ranges ("≈ £800–1,200 /mo").
    const amounts = src.match(/£\s?\d[\d,.]*/g) ?? [];
    const ours = amounts.filter((a) => !/£(800|1,200|500|1,500|2,400)/.test(a));
    assert.deepStrictEqual(ours, [], `typed prices: ${ours.join(', ')}`);
});

check('the pricing page reads monthly AND annual prices from get-plans', () => {
    const src = read('pricing.html');
    assert.ok(src.includes('plan.annualMonthlyGbp') && src.includes('plan.annualTotalGbp'));
    const fn = read('netlify/functions/get-plans.ts');
    assert.ok(fn.includes('annualAmountGbp(p.monthlyPriceGbp)'), 'annual comes from the checkout helper');
});

check('the homepage and Billing page mark prices instead of typing them', () => {
    for (const f of ['index.html', 'billing.js']) {
        // The referral reward ("£10 credit") is not a plan price.
        const src = code(read(f)).replace(/£10 credit/g, '');
        assert.ok(!/£\s?\d/.test(src), `${f} has a typed £ amount`);
        assert.ok(src.includes('data-plan-price="buster"'), `${f} marks the Buster price`);
    }
    assert.ok(read('index.html').includes('src="./plan-prices.js"'));
    assert.ok(read('workspace.html').includes('src="/plan-prices.js"'));
});

check('the trial email quotes prices through tokens the sender fills', () => {
    const t = getTemplateDefault('trial_ending_soon');
    assert.ok(t);
    assert.ok(!/£\s?\d/.test(t!.bodyHtml), 'typed price in the template');
    assert.ok(t!.bodyHtml.includes('{{plans.saver_price}}') && t!.bodyHtml.includes('{{plans.buster_price}}'));
    assert.ok(read('netlify/functions/trial-sweep.ts').includes('plans: prices'));
});

check('help articles are served with the tokens filled', () => {
    assert.ok(read('netlify/functions/get-help-articles.ts').includes('fillPlanPriceTokens('));
    const vars = { saver_price: formatGbp('29.00'), buster_price: formatGbp(69) };
    assert.strictEqual(
        fillPlanPriceTokens('| **The Busywork Buster** | {{plans.buster_price}} / month | and {{ plans.saver_price }}', vars),
        '| **The Busywork Buster** | £69 / month | and £29',
    );
    // A missing price leaves the token visible rather than inventing one.
    assert.strictEqual(fillPlanPriceTokens('{{plans.buster_price}}', { saver_price: '', buster_price: '' }), '{{plans.buster_price}}');
});

check('formatGbp drops pence only when there are none', () => {
    assert.strictEqual(formatGbp('69.00'), '£69');
    assert.strictEqual(formatGbp(55.2), '£55.2');
    assert.strictEqual(formatGbp(0), '');
});

console.log(`\n${passed} passed`);
