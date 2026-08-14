// tests/post-quality-review.test.ts
// Locks the rules that stop the quality reviewer becoming a treadmill. No network or DB.
// Run:  npx tsx tests/post-quality-review.test.ts
//
// The bug these guard against shipped once already: the panel re-ran the FULL review after every
// assisted rewrite, a model asked for suggestions always returns some, so accepting a rewrite
// produced three fresh suggestions offering another rewrite, forever. The invariants below are the
// ones that make the loop terminate and make a settled compliance warning stay settled.

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { landmark } from './landmark';
import {
    hasComplianceWarnings, hashCaption, openWarnings, readCachedReview, normaliseVoiceScore,
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

// ── The brand-voice score ───────────────────────────────────────────────────────────────────────
// Step 6 read "Brand voice 0/100" in red on every post, however good the caption. Two causes, and
// the first is what made it look like a verdict rather than a gap: `Number(x) || 0` turned a
// missing score into 0, which is an ordinary-looking mark. An unknown has to look unknown.

check('an absent score is null, not zero', () => {
    for (const raw of [null, undefined, '', 'n/a', 'high', NaN, {}]) {
        assert.strictEqual(normaliseVoiceScore(raw), null,
            `${JSON.stringify(raw)} became a score — this is what printed 0/100 on every post`);
    }
});

check('a real score still comes through, including a real zero', () => {
    assert.strictEqual(normaliseVoiceScore(0), 0, 'a genuinely off-brand post can score 0');
    assert.strictEqual(normaliseVoiceScore(72), 72);
    assert.strictEqual(normaliseVoiceScore('72'), 72, 'models quote numbers');
    assert.strictEqual(normaliseVoiceScore(72.4), 72);
});

check('an out-of-range score is clamped rather than dropped', () => {
    assert.strictEqual(normaliseVoiceScore(140), 100);
    assert.strictEqual(normaliseVoiceScore(-20), 0);
});

check('the compliance-only prompt still demands a score', () => {
    // The second cause: that pass told the reviewer "Style feedback is not being requested here",
    // and brand voice IS style — so it dropped the score, and every post came back unscored.
    const src = readFileSync(path.join(import.meta.dirname, '..', 'src/utils/post-quality-review.ts'), 'utf8');
    assert.ok(!/Style feedback is not being requested here\./.test(src),
        'a blanket "no style feedback" also switches off the brand-voice score');
    assert.match(src, /brandVoiceScore is still required/,
        'the no-suggestions pass must say the score is exempt');
    assert.match(src, /ALWAYS return this, on every review/);
});

check('the panel shows an unknown as unknown, not as 0 in red', () => {
    const ws = readFileSync(path.join(import.meta.dirname, '..', 'workspace.html'), 'utf8');
    const render = ws.slice(landmark(ws, 'function _prqRenderReview('), landmark(ws, 'const warnings = data.complianceWarnings'));
    assert.match(render, /Brand voice not scored/, 'null needs its own wording');
    assert.match(render, /text-gray-400/, 'and its own colour — red reads as a bad score');
    assert.ok(!/typeof data\.brandVoiceScore === 'number'\) \{\n        const s = data/.test(render),
        'the old guard left the previous post\'s score on screen when this one had none');
});

console.log(`\n${passed} passed, 0 failed\n`);
