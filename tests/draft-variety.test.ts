// tests/draft-variety.test.ts
// The anti-repetition context a social draft is generated against.
//
// The bug this exists to stop recurring: the reviewer opens a queue full of near-identical drafts
// and loses confidence that the assistant can do the job at all. Two separate defects fed it —
// the corpus was far too small (8 posts, under two days for a daily cross-poster), and the query
// that built it sorted `generated_at DESC`, which in Postgres puts NULLs FIRST. Every post the
// calendar composer or a rejection-clone created has a NULL generated_at, so those filled all
// eight slots and the model was drafting against essentially nothing.
//
// Run:  npx tsx tests/draft-variety.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { buildVarietyBlock, VARIETY_LOOKBACK, VARIETY_VISUAL_LOOKBACK, type PriorPost } from '../src/utils/draft-variety';
import { landmark } from './landmark';

let passed = 0;
const test = (name: string, fn: () => void) => {
    try { fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (err) { console.error(`  ✗ ${name}\n    ${err instanceof Error ? err.message : err}`); process.exitCode = 1; }
};

const post = (caption: string | null, media: string | null = null): PriorPost => ({ caption, media });

console.log('\nDraft variety — the corpus a new draft is written against\n');

test('the lookback is wide enough to span more than a day of cross-posting', () => {
    // 8 was the old value and the reason premises recurred within the same review queue.
    assert.ok(VARIETY_LOOKBACK >= 20, `lookback ${VARIETY_LOOKBACK} is too short to prevent repetition`);
    assert.ok(VARIETY_VISUAL_LOOKBACK <= VARIETY_LOOKBACK, 'visual lookback should not exceed the caption lookback');
});

test('prior captions are listed as things not to repeat', () => {
    const block = buildVarietyBlock([post('Stop drowning in admin.'), post('Three ways to reclaim your Friday.')]);
    assert.match(block, /ALREADY DRAFTED RECENTLY/);
    assert.match(block, /Stop drowning in admin\./);
    assert.match(block, /Three ways to reclaim your Friday\./);
});

test('the block says the corpus spans every status, not just drafts', () => {
    // The model was previously told only "already drafted", which understates the corpus: a
    // published post is the one a repeat is most embarrassing against.
    const block = buildVarietyBlock([post('A caption.')]);
    assert.match(block, /awaiting review, scheduled, already published or rejected/);
});

test('visuals are listed separately so image concepts stop repeating', () => {
    const block = buildVarietyBlock([post('A caption.', 'a laptop on a desk')]);
    assert.match(block, /RECENT VISUALS/);
    assert.match(block, /a laptop on a desk/);
});

test('captions are truncated so a long corpus cannot swamp the prompt', () => {
    const long = 'x'.repeat(500);
    const block = buildVarietyBlock([post(long, long)]);
    for (const line of block.split('\n').filter(l => l.startsWith('- "'))) {
        assert.ok(line.length < 200, `entry not truncated: ${line.length} chars`);
    }
});

test('captions beyond the lookback are dropped, newest kept', () => {
    const rows = Array.from({ length: VARIETY_LOOKBACK + 10 }, (_, i) => post(`caption number ${i}`));
    const block = buildVarietyBlock(rows);
    assert.match(block, /caption number 0/, 'the newest row must be present');
    assert.doesNotMatch(block, new RegExp(`caption number ${VARIETY_LOOKBACK + 5}`), 'beyond the lookback must be dropped');
});

test('a brand-new assistant gets no block at all', () => {
    // Not an empty heading with nothing under it — the prompt should be byte-identical to before.
    assert.equal(buildVarietyBlock([]), '');
    assert.equal(buildVarietyBlock([post(null, null)]), '');
    assert.equal(buildVarietyBlock([post('   ')]), '');
});

test('a post with a caption but no media still contributes its hook', () => {
    const block = buildVarietyBlock([post('A real caption.', null)]);
    assert.match(block, /A real caption\./);
    assert.doesNotMatch(block, /RECENT VISUALS/, 'no visuals means no visuals heading');
});

test('the drafting query orders by a NOT NULL timestamp, not bare generated_at DESC', () => {
    // The regression that made all of the above pointless. Postgres sorts NULLs FIRST on DESC, so
    // `generated_at desc` promoted every hand-composed post to the top of the corpus.
    const src = readFileSync(new URL('../netlify/functions/process-content-jobs.ts', import.meta.url), 'utf8');
    const idx = src.indexOf('recentBlock = buildVarietyBlock');
    assert.ok(idx > 0, 'the variety block should be built by the shared helper');
    const query = src.slice(Math.max(0, idx - 900), idx);
    assert.match(query, /coalesce\(/, 'ordering must coalesce generated_at with a NOT NULL column');
    assert.ok(
        !/orderBy\(desc\(scheduledPosts\.generatedAt\)\)/.test(query),
        'bare generated_at DESC is back — NULLs will sort first and gut the corpus',
    );
});

test('the corpus is not narrowed to a single status', () => {
    const src = readFileSync(new URL('../netlify/functions/process-content-jobs.ts', import.meta.url), 'utf8');
    const idx = landmark(src, 'recentBlock = buildVarietyBlock');
    const query = src.slice(Math.max(0, idx - 900), idx);
    assert.ok(
        !/scheduledPosts\.status/.test(query),
        'the variety corpus must span pending_approval, scheduled and published alike',
    );
});

console.log(`\n${passed} passed${process.exitCode ? ', some failed' : ''}\n`);
