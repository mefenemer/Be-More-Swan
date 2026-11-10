// tests/homepage-faq-2026-11-03.test.ts
// The home page "Questions owners ask us" section (Mystery Shopper suggestion, 2026-11-03) and the
// FAQPage JSON-LD the build makes from it (homeFaqJsonLd in scripts/seo/ai-readability.mjs).
// What could drift without anything failing:
//
//   · a connector named as working that connections.html marks Coming soon (the suggestion's own
//     draft said HubSpot, Salesforce and Xero worked today)
//   · a typed price or task allowance — both live in master data
//   · structured data that says more than the page shows: a price sentence the bake left hidden
//     must not reach the JSON-LD
//
// Run:  npx tsx tests/homepage-faq-2026-11-03.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bakePlanPriceSlots, homeFaqJsonLd } from '../scripts/seo/ai-readability.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f: string) => readFileSync(join(root, f), 'utf8');
const code = (s: string) => s.replace(/<!--[\s\S]*?-->/g, '');

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}`); throw err; }
}

const PLANS = [
    { tierKey: 'saver', monthlyPriceGbp: '29.00' },
    { tierKey: 'buster', monthlyPriceGbp: '69.00' },
];
const html = read('index.html');
const start = code(html).indexOf('id="home-faq"');
const faq = code(html).slice(start, code(html).indexOf('</section>', start));
const ld = (h: string) => JSON.parse(homeFaqJsonLd(h).replace(/^[\s\S]*?<script[^>]*>|<\/script>\s*$/g, ''));

console.log('homepage-faq-2026-11-03');

check('every question is a visible H3 followed by its answer', () => {
    assert.ok(start > -1, '#home-faq present');
    assert.strictEqual((faq.match(/<h3\b/g) || []).length, 8);
    assert.ok(!faq.includes('<details'), 'answers are not collapsed');
});

check('no typed price or task allowance', () => {
    assert.ok(!/£\d/.test(faq), 'prices come from data-plan-price tokens');
    assert.ok(!/\d[\d,]* tasks/.test(faq), 'task allowances are left to pricing.html');
    assert.match(faq, /<span data-plan-prices-ready hidden>The Workflow Saver is <span data-plan-price="saver"><\/span>\/month/);
});

check('connectors named as working are Live on connections.html, and the Coming-soon ones say so', () => {
    const conn = read('connections.html');
    const live = (name: string) => new RegExp(`<h4>${name}</h4><span class="cx-pill cx-live">`).test(conn);
    for (const name of ['Facebook', 'Instagram', 'LinkedIn', 'X', 'Gmail', 'Outlook', 'Google Search Console', 'Canva']) {
        assert.ok(live(name), `${name} is Live on connections.html`);
    }
    // YouTube: Google approved the project's verification on 2026-11-05, so the YouTube card is Live again.
    // One card since 2026-11-10: the Video Producer's copy was removed — it posts nothing, the Social
    // Media Assistant does (connection-map.ts gives video_producer Canva only).
    assert.strictEqual((conn.match(/<h4>YouTube<\/h4><span class="cx-pill cx-live">/g) || []).length, 1, 'the YouTube card is Live');
    assert.ok(!/<h4>YouTube<\/h4><span class="cx-pill cx-soon">/.test(conn), 'no YouTube card is Coming soon');
    // Slack and Notion only run for the Minute Taker, which is itself coming soon.
    for (const name of ['Slack', 'Notion']) {
        assert.ok(!live(name), `${name} is not Live on connections.html`);
        assert.ok(!faq.includes(name), `${name} is not named as working in the FAQ`);
    }
    assert.ok(faq.includes('HubSpot, Salesforce and Xero are coming soon'));
    // Nor anywhere else on the homepage: Cat's customer story used to say she used "a connected Notion pad".
    if (!live('Notion')) assert.ok(!/\bNotion\b/.test(read('index.html')), 'the homepage names Notion only once it is Live');
});

check('the JSON-LD matches the questions, with prices once baked', () => {
    const data = ld(bakePlanPriceSlots(html, PLANS).html);
    assert.strictEqual(data['@type'], 'FAQPage');
    assert.strictEqual(data.mainEntity.length, 8);
    const cost = data.mainEntity.find((e: { name: string }) => e.name === 'What does it cost?');
    assert.match(cost.acceptedAnswer.text, /^The Workflow Saver is £29\/month and The Busywork Buster is £69\/month\. /);
});

check('an unbaked (hidden) price sentence stays out of the JSON-LD', () => {
    const cost = ld(html).mainEntity.find((e: { name: string }) => e.name === 'What does it cost?');
    assert.ok(!cost.acceptedAnswer.text.includes('/month'), cost.acceptedAnswer.text);
    assert.match(cost.acceptedAnswer.text, /^The Workflow Saver gives you one assistant/);
});

check('the build runs the job after the price bake', () => {
    const build = read('scripts/build-seo-html.mjs');
    const bake = build.indexOf('\nawait bakePlanPrices();');
    assert.ok(bake > -1);
    assert.ok(build.indexOf('\nbuildHomeFaqJsonLd();') > bake);
});

console.log(`\n${passed} passed`);
