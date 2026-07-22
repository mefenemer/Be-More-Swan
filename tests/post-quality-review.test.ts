// tests/post-quality-review.test.ts
// Locks the rules that stop the quality reviewer becoming a treadmill. No network or DB.
// Run:  npx tsx tests/post-quality-review.test.ts
//
// The bug these guard against shipped once already: the panel re-ran the FULL review after every
// assisted rewrite, a model asked for suggestions always returns some, so accepting a rewrite
// produced three fresh suggestions offering another rewrite, forever. The invariants below are the
// ones that make the loop terminate and make a settled compliance warning stay settled.

import assert from 'node:assert';
import {
    hasComplianceWarnings, hashCaption, openWarnings, readCachedReview,
    type QualityReview, type WarningDisposition,
} from '../src/utils/post-quality-review';

let passed = 0;
function check(name: string, fn: () => void) { fn(); console.log(`  ✓ ${name}`); passed++; }

const CAPTION = 'The average small business runs 8.2 software subscriptions.';

function disposition(over: Partial<WarningDisposition> = {}): WarningDisposition {
    return {
        action: 'sourced',
        sourceUrl: 'https://example.com/study',
        userId: 7,
        at: '2026-07-22T10:00:00.000Z',
        captionHashAtDisposition: hashCaption(CAPTION),
        ...over,
    };
}

function review(over: Partial<QualityReview> = {}): QualityReview {
    return {
        brandVoiceScore: 80,
        complianceWarnings: ['Verify the 8.2 statistic', 'Verify the two-clicks claim'],
        suggestions: [],
        cachedAt: '2026-07-22T10:00:00.000Z',
        captionHash: hashCaption(CAPTION),
        ...over,
    };
}

// ── The cache key ───────────────────────────────────────────────────────────
check('a verdict survives only while the caption it judged is unchanged', () => {
    assert.ok(readCachedReview(review(), CAPTION));
    // Otherwise a user edits away the flagged sentence, keeps the clean verdict, and approves
    // against a review of text that no longer exists.
    assert.equal(readCachedReview(review(), CAPTION + ' Now with more claims.'), null);
});

check('a missing or malformed review is simply absent, not a crash', () => {
    assert.equal(readCachedReview(null, CAPTION), null);
    assert.equal(readCachedReview('not an object', CAPTION), null);
    assert.equal(readCachedReview(undefined, CAPTION), null);
});

// ── What actually blocks approval ───────────────────────────────────────────
check('undisposed warnings block approval', () => {
    assert.deepEqual(openWarnings(review()), ['Verify the 8.2 statistic', 'Verify the two-clicks claim']);
    assert.equal(hasComplianceWarnings(review()), true);
});

check('a warning answered with a source stops blocking but stays on the record', () => {
    const r = review({ dispositions: { 'Verify the 8.2 statistic': disposition() } });
    assert.deepEqual(openWarnings(r), ['Verify the two-clicks claim']);
    assert.equal(hasComplianceWarnings(r), true, 'the other warning is still open');
    // Settled ≠ deleted: the audit record must still show what was raised.
    assert.equal(r.complianceWarnings.length, 2);
});

check('settling every warning clears the gate', () => {
    const r = review({
        dispositions: {
            'Verify the 8.2 statistic': disposition(),
            'Verify the two-clicks claim': disposition({ action: 'not_applicable', note: 'Measured it', sourceUrl: undefined }),
        },
    });
    assert.deepEqual(openWarnings(r), []);
    assert.equal(hasComplianceWarnings(r), false);
});

check('a disposition for a warning that is no longer raised does not clear a live one', () => {
    // Stale keys must not pre-clear anything: dispositions are matched by exact warning text.
    const r = review({ dispositions: { 'Some warning from a previous caption': disposition() } });
    assert.deepEqual(openWarnings(r), ['Verify the 8.2 statistic', 'Verify the two-clicks claim']);
});

check('no review at all means nothing to block on', () => {
    assert.deepEqual(openWarnings(null), []);
    assert.equal(hasComplianceWarnings(null), false);
});

check('a review with an empty warning list is clean', () => {
    assert.equal(hasComplianceWarnings(review({ complianceWarnings: [] })), false);
});

// NOT covered here, deliberately: the round cap and the suggestions-only-on-request rule live in
// runQualityReview / apply-post-suggestions, which need a database and the AI gateway. Asserting
// them against hand-built objects would only re-state the fixtures. They are exercised by the
// smoke test in the PR notes instead.

console.log(`\n${passed} passed, 0 failed\n`);
