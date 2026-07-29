// tests/near-duplicate.test.ts
// The gate that verifies a generated caption is actually new.
//
// Telling the model "bring a different angle" is advice; this is the check that it complied. It
// exists because a reviewer opening a queue of near-identical drafts stops believing the assistant
// can do the job — the cost of a miss is trust, not tokens.
//
// The two failure directions are NOT symmetric and both are tested:
//   - a MISS ships a duplicate to the queue (the bug we are fixing);
//   - a FALSE POSITIVE spends a second generation call on a perfectly good draft, and the drainer
//     runs to a 26s cap, so a trigger-happy threshold turns into timeouts.
// The "must NOT trip" cases below are therefore load-bearing, not padding.
//
// Run:  npx tsx tests/near-duplicate.test.ts

import assert from 'node:assert';
import {
    captionSimilarity, findNearDuplicate, normaliseForCompare, nearDuplicateRetryPrompt,
    NEAR_DUPLICATE_WHOLE, NEAR_DUPLICATE_HOOK, type PriorPost,
} from '../src/utils/draft-variety';

let passed = 0;
const test = (name: string, fn: () => void) => {
    try { fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (err) { console.error(`  ✗ ${name}\n    ${err instanceof Error ? err.message : err}`); process.exitCode = 1; }
};

const priors = (...captions: string[]): PriorPost[] => captions.map(c => ({ caption: c, media: null }));

console.log('\nNear-duplicate gate\n');

// ── Must trip ────────────────────────────────────────────────────────────────────────────────

test('an identical caption trips', () => {
    const c = 'Most founders lose four hours a week to admin they never chose to do.';
    assert.ok(findNearDuplicate(c, priors(c)), 'identical must trip');
    assert.equal(captionSimilarity(c, c), 1);
});

test('the same post lightly reworded trips', () => {
    const a = 'Most founders lose four hours a week to admin they never chose to do.';
    const b = 'Most founders lose four hours every week to admin work they never chose to do.';
    assert.ok(findNearDuplicate(b, priors(a)), `reworded duplicate missed (score ${captionSimilarity(a, b).toFixed(2)})`);
});

test('the same post with different hashtags and emoji trips', () => {
    // Hashtags and emoji are the cheapest possible "change" and must not disguise a repeat.
    const a = 'Stop drowning in admin. Your evenings are not a business expense.';
    const b = 'Stop drowning in admin! 🦢 Your evenings are not a business expense. #founder #smallbiz';
    assert.ok(findNearDuplicate(b, priors(a)), `cosmetic variation missed (score ${captionSimilarity(a, b).toFixed(2)})`);
});

test('a shared opening hook trips even when the bodies diverge', () => {
    // The specific thing the first live cross-post batch produced: four posts, one formula.
    const a = 'You did not start a business to become an admin clerk. Here is how we fixed that for a bakery in Leeds.';
    const b = 'You did not start a business to become an admin clerk. Last month a plumber told us he bills at midnight.';
    assert.ok(findNearDuplicate(b, priors(a)), `shared hook missed (score ${captionSimilarity(a, b).toFixed(2)})`);
});

test('the worst offender is the one reported, not merely the first', () => {
    const target = 'Stop drowning in admin. Your evenings are not a business expense.';
    const found = findNearDuplicate(target, priors(
        'Stop drowning in admin. Your weekends are not a business expense either.',
        target,
    ));
    assert.equal(found?.caption, target, 'must quote the closest match for the corrective re-ask');
});

// ── Must NOT trip ────────────────────────────────────────────────────────────────────────────

test('two posts sharing a content pillar do not trip', () => {
    // Same theme, same vocabulary, genuinely different posts. Tripping here burns a generation.
    const a = 'Admin is not the job. We built a digital assistant that files your receipts while you sleep.';
    const b = 'Chasing invoices costs the average trades business a full day a month. Here is what we automated first.';
    assert.equal(findNearDuplicate(b, priors(a)), null, `false positive (score ${captionSimilarity(a, b).toFixed(2)})`);
});

test('posts that merely open with the same common words do not trip', () => {
    const a = 'Here is the thing about hiring: most small businesses wait far too long to delegate.';
    const b = 'Here is what changed for us in April: three assistants, one afternoon of setup.';
    assert.equal(findNearDuplicate(b, priors(a)), null, `false positive (score ${captionSimilarity(a, b).toFixed(2)})`);
});

test('a genuinely different post against a full corpus does not trip', () => {
    const corpus = priors(
        'Stop drowning in admin. Your evenings are not a business expense.',
        'Three ways to reclaim your Friday afternoon.',
        'We asked 40 founders what they would delegate first. The answer surprised us.',
        'Invoice chasing is the tax you did not budget for.',
    );
    const fresh = 'Our new Threads integration is live — schedule once, publish everywhere, review in one place.';
    assert.equal(findNearDuplicate(fresh, corpus), null, 'a genuinely new post must pass');
});

// ── Edges ────────────────────────────────────────────────────────────────────────────────────

test('very short captions are never judged', () => {
    // Too little signal to be confident, and a wrong trip costs a real generation call.
    assert.equal(findNearDuplicate('Big news!', priors('Big news!')), null);
    assert.equal(captionSimilarity('Big news!', 'Big news!'), 0);
});

test('empty and null priors are ignored, not crashed on', () => {
    const c = 'Most founders lose four hours a week to admin they never chose to do.';
    assert.equal(findNearDuplicate(c, []), null);
    assert.equal(findNearDuplicate(c, [{ caption: null, media: null }, { caption: '', media: null }]), null);
    assert.equal(findNearDuplicate('', priors(c)), null);
});

test('normalisation strips the noise that hides a repeat', () => {
    const words = normaliseForCompare('Stop DROWNING in admin! 🦢 #founder @swan https://example.com/x');
    assert.deepEqual(words, ['stop', 'drowning', 'in', 'admin']);
});

test('thresholds stay in the band they were tuned for', () => {
    // A guard on the tuning itself: dropping these towards zero would make every draft trip and
    // double the cost of drafting, which is the failure this gate must not become.
    assert.ok(NEAR_DUPLICATE_WHOLE >= 0.35 && NEAR_DUPLICATE_WHOLE <= 0.6, 'whole-caption threshold out of band');
    assert.ok(NEAR_DUPLICATE_HOOK >= 0.6 && NEAR_DUPLICATE_HOOK <= 0.85, 'hook threshold out of band');
});

test('the corrective prompt shows the model the collision', () => {
    // A re-ask that does not quote the existing post just gets the same idea reworded.
    const dup = { caption: 'Stop drowning in admin. Your evenings are not a business expense.', score: 0.9 };
    const prompt = nearDuplicateRetryPrompt(dup);
    assert.match(prompt, /Stop drowning in admin/, 'must quote the existing post');
    assert.match(prompt, /different opening hook/i);
    assert.match(prompt, /JSON/, 'must restate the required reply shape');
});

test('the gate is bounded to a single re-ask', () => {
    // The rule that stops an AI-critique loop being infinite. Verified against the call site: one
    // gatewayGenerate inside the duplicate branch, and no loop around it.
    const src = require('node:fs').readFileSync(
        new URL('../netlify/functions/process-content-jobs.ts', import.meta.url), 'utf8');
    const start = src.indexOf('Near-duplicate gate');
    const end = src.indexOf('The raw model caption', start);
    const block = src.slice(start, end);
    assert.ok(start > 0 && end > start, 'gate block not found');
    assert.equal((block.match(/gatewayGenerate\(/g) || []).length, 1, 'exactly one re-ask');
    assert.ok(!/\b(for|while)\s*\(/.test(block), 'no loop around the re-ask');
    assert.match(block, /catch/, 'must fail open, never block the draft');
});

console.log(`\n${passed} passed${process.exitCode ? ', some failed' : ''}\n`);
