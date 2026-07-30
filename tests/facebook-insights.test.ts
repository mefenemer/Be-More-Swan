// tests/facebook-insights.test.ts
// The one piece of ingest-facebook-insights.ts that is pure logic rather than a Graph call, and the
// one that decides whether `facebook_link_clicks` means what it says.
// Run:  npx tsx tests/facebook-insights.test.ts
//
// WHY THIS MATTERS MORE THAN IT LOOKS: facebook_link_clicks is the Social Media Manager's ONLY
// action metric — Instagram cannot report per-post link clicks at all, which is why that objective
// stood empty for social roles. If this parser quietly returns the wrong number, a user sets a
// traffic goal, watches a progress bar move, and the bar is measuring people expanding a caption.

import assert from 'node:assert';
import { linkClicksFrom } from '../netlify/functions/ingest-facebook-insights';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

check('extracts only the link clicks from a clicks-by-type breakdown', () => {
    // The shape Graph actually returns for post_clicks_by_type.
    assert.equal(linkClicksFrom({ 'other clicks': 120, 'link clicks': 34, 'photo view': 61 }), 34);
});

check('never falls back to the total click count', () => {
    // THE CORRECTNESS POINT. "other clicks" counts expanding the caption, clicking the Page name,
    // clicking through to comments — none of which is traffic to the business. Summing the lot would
    // inflate a traffic goal by whatever share of clicks were people reading the post, which on a
    // text-heavy post is most of them. No link-clicks key ⇒ no answer.
    assert.equal(linkClicksFrom({ 'other clicks': 500, 'photo view': 200 }), null);
});

check('tolerates the key arriving underscored or oddly spaced', () => {
    // Graph has shipped this key both ways across versions, and a rename here would silently zero
    // every traffic goal rather than erroring.
    assert.equal(linkClicksFrom({ link_clicks: 12 }), 12);
    assert.equal(linkClicksFrom({ 'Link  Clicks': 7 }), 7);
});

check('an absent or malformed breakdown yields null, never 0', () => {
    // null = "we did not measure this post"; 0 = "this post earned no clicks". Collapsing the first
    // into the second makes an ingest failure indistinguishable from genuinely poor performance —
    // and the SUM in poll-goal-telemetry would then report a confidently wrong total.
    assert.equal(linkClicksFrom(undefined), null);
    assert.equal(linkClicksFrom(null), null);
    assert.equal(linkClicksFrom(42), null);
    assert.equal(linkClicksFrom('link clicks: 3'), null);
    assert.equal(linkClicksFrom({ 'link clicks': 'lots' }), null);
    assert.equal(linkClicksFrom({}), null);
});

check('zero link clicks is preserved as 0', () => {
    // The inverse of the rule above: Graph explicitly reporting none is real data.
    assert.equal(linkClicksFrom({ 'other clicks': 9, 'link clicks': 0 }), 0);
});

console.log(`\n${passed} checks passed.`);
