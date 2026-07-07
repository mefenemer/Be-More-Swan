// tests/gsc-decay.test.ts
// Locks the pure maths for the GSC content-decay loop (US 5.1): date-window offset, property
// matching (URL-prefix vs sc-domain), and the peak-relative decay rule. No network or DB.
// Run:  npx tsx tests/gsc-decay.test.ts

import assert from 'node:assert';
import { gscDateRange, matchProperty, evaluateDecay } from '../src/utils/gsc-decay';

let passed = 0;
function check(name: string, fn: () => void) { fn(); console.log(`  ✓ ${name}`); passed++; }

// ── gscDateRange ────────────────────────────────────────────────────────────
check('gscDateRange offsets by lag and spans lookback days', () => {
    const now = new Date('2026-07-07T00:00:00Z');
    const { startDate, endDate } = gscDateRange(28, 3, now);
    assert.equal(endDate, '2026-07-04');   // now - 3 lag days
    assert.equal(startDate, '2026-06-06'); // end - 28 lookback days
});

// ── matchProperty ───────────────────────────────────────────────────────────
check('matchProperty prefers the longest URL-prefix property', () => {
    const props = ['https://example.com/', 'https://example.com/blog/'];
    assert.equal(matchProperty('https://example.com/blog/my-post', props), 'https://example.com/blog/');
});

check('matchProperty falls back to a domain property', () => {
    assert.equal(matchProperty('https://sub.example.com/x', ['sc-domain:example.com']), 'sc-domain:example.com');
});

check('matchProperty prefers URL-prefix over domain when both match', () => {
    const props = ['sc-domain:example.com', 'https://example.com/'];
    assert.equal(matchProperty('https://example.com/post', props), 'https://example.com/');
});

check('matchProperty returns null on no match or bad URL', () => {
    assert.equal(matchProperty('https://other.com/x', ['sc-domain:example.com']), null);
    assert.equal(matchProperty('not a url', ['https://example.com/']), null);
});

// ── evaluateDecay ───────────────────────────────────────────────────────────
const cfg = { minBaseline: 50, decayRatio: 0.6 };

check('first observation seeds the baseline, never decays', () => {
    assert.deepEqual(evaluateDecay({ baseline: null, current: 120, ...cfg }), { newBaseline: 120, decayed: false });
});

check('a new high raises the peak and does not decay', () => {
    assert.deepEqual(evaluateDecay({ baseline: 100, current: 140, ...cfg }), { newBaseline: 140, decayed: false });
});

check('a drop below ratio*peak flags decay (peak retained)', () => {
    assert.deepEqual(evaluateDecay({ baseline: 100, current: 55, ...cfg }), { newBaseline: 100, decayed: true });
});

check('a shallow dip above the threshold does not decay', () => {
    assert.deepEqual(evaluateDecay({ baseline: 100, current: 70, ...cfg }), { newBaseline: 100, decayed: false });
});

check('tiny-traffic posts below minBaseline never decay', () => {
    assert.deepEqual(evaluateDecay({ baseline: 40, current: 5, ...cfg }), { newBaseline: 40, decayed: false });
});

console.log(`\n${passed} checks passed.`);
