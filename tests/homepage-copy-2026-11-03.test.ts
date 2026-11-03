// tests/homepage-copy-2026-11-03.test.ts
// Five Mystery Shopper suggestions applied to index.html (2026-11-03), each checked against the
// product first. What could drift back without anything failing:
//
//   · the closing CTA typing a plan price instead of the plan-prices.js tokens (the suggestion
//     itself said "£69" — right today, wrong the next time Master Data changes)
//   · the replanning sentence naming only The Busywork Buster, when GOAL_AI_TIERS.autonomous
//     (src/config/goal-metrics.ts) also covers employee and enterprise
//   · "pivots the strategy instantly" — the old claim, true for no plan below the Buster
//   · approval copy reading as absolute, when per-platform auto-publish is opt-in
//     (src/utils/publish-policy.ts)
//
// Run:  npx tsx tests/homepage-copy-2026-11-03.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GOAL_AI_TIERS } from '../src/config/goal-metrics';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f: string) => readFileSync(join(root, f), 'utf8');
/** Source with comments removed, so a comment that mentions an old claim does not count. */
const code = (s: string) => s.replace(/<!--[\s\S]*?-->/g, '');

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}`); throw err; }
}

console.log('homepage-copy-2026-11-03');
const html = code(read('index.html'));

check('the closing CTA names both plans with price tokens, never a typed price', () => {
    const start = html.indexOf('Ready to get your time back?');
    assert.ok(start > -1, 'closing CTA heading present');
    const cta = html.slice(start, html.indexOf('</p>', start));
    assert.match(cta, /The Workflow Saver at <span data-plan-price="saver"><\/span>\/month/);
    assert.match(cta, /The Busywork Buster at <span data-plan-price="buster"><\/span>\/month/);
    assert.match(cta, /<span data-plan-prices-ready hidden>/, 'sentence hidden until prices load');
    assert.ok(!/£\d/.test(cta), 'no typed price in the closing CTA');
});

check('the replanning claim matches the tiers that actually replan', () => {
    assert.deepStrictEqual([...GOAL_AI_TIERS.autonomous], ['buster', 'employee', 'enterprise']);
    assert.ok(html.includes('On The Busywork Buster and above, your assistants also change their own plan'));
    assert.ok(!html.includes('pivots the strategy'), 'old "pivots the strategy instantly" claim gone');
});

check('approval copy keeps the opt-out', () => {
    assert.ok(html.includes('every draft waits for your OK before it goes out, unless you choose otherwise'));
    assert.match(read('llms.txt'), /by default nothing goes out until the owner approves it/);
});

check('the opening paragraph names who and where, with no placeholder brackets', () => {
    assert.ok(html.includes('Pre-trained online assistants for your social media, blog, email, leads, website and more, for start-ups and small businesses in the UK.'));
    assert.ok(!/\[the UK|countries you serve\]/.test(html), 'no Mystery Shopper placeholder shipped');
});

check('the What\'s Included heading is the question', () => {
    assert.ok(html.includes("What's included in each plan, and what does it cost?"));
    assert.ok(!html.includes("Here's Exactly What's Included"));
});

console.log(`\n${passed} passed`);
