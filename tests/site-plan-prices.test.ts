// tests/site-plan-prices.test.ts
// The Mystery Shopper reads our plan prices the way a visitor sees them (2026-10-27).
//
// WHY THIS EXISTS. index.html types no price; plan-prices.js fills <span data-plan-price> in the browser.
// The audit runs no scripts, so it read "Plans start at /month" and suggested typing "£29" back in —
// the very thing tests/no-hardcoded-plan-prices.test.ts forbids. site-plan-prices.ts now fills the
// markers from the site's own get-plans before the page is extracted.
//
// Run:  npx tsx tests/site-plan-prices.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fillPlanPriceMarkers } from '../src/utils/site-plan-prices';
import { extractSitePage } from '../src/utils/site-extract';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f: string) => readFileSync(join(root, f), 'utf8');

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}`); throw err; }
}

const PLANS = [{ tierKey: 'saver', monthlyPriceGbp: '29.00' }, { tierKey: 'buster', monthlyPriceGbp: 69 }];
/** Everything the lenses are shown — the excerpt is capped, so the pricing signals count too. */
const textOf = (html: string) => JSON.stringify(extractSitePage(html, 'https://bemoreswan.com/'));

console.log('site-plan-prices');

check('the homepage, as the audit reads it, quotes the prices a visitor sees', () => {
    const text = textOf(fillPlanPriceMarkers(read('index.html'), PLANS));
    assert.match(text, /Plans start at £29\/month/);
    assert.match(text, /The Workflow Saver \(£29\/month\)/);
    assert.match(text, /The Busywork Buster \(£69\/month\)/);
    assert.doesNotMatch(text, /\(\/month\)| at \/month/);
});

check('a price that is missing keeps the whole sentence out, as it stays hidden on screen', () => {
    const text = textOf(fillPlanPriceMarkers(read('index.html'), [PLANS[0]]));
    assert.match(text, /No hidden tiers\./);
    assert.doesNotMatch(text, /\/month/);
    assert.doesNotMatch(textOf(fillPlanPriceMarkers(read('index.html'), [])), /\/month/);
});

check('a page without the markers is returned untouched', () => {
    const html = '<html><body><p>Plans from £10</p></body></html>';
    assert.strictEqual(fillPlanPriceMarkers(html, PLANS), html);
});

check('the live fetch fills the markers before extracting', () => {
    const src = read('src/utils/site-audit.ts');
    const fn = src.slice(src.indexOf('export async function fetchSitePageLive'), src.indexOf('// ── Database layer'));
    assert.ok(fn.indexOf('fillSitePlanPrices(') > 0 && fn.indexOf('fillSitePlanPrices(') < fn.indexOf('extractSitePage('));
});

console.log(`\n${passed} checks passed.`);
