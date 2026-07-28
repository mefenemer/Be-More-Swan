// tests/my-content-status.test.ts
// My Content classifies an asset from the posts that USE it, by the same rule the Calendar reads.
//
// ── The bug ─────────────────────────────────────────────────────────────────────────────────────
// content_assets.status is a denormalised copy maintained by hand-written transitions in
// scheduled-posts.ts. Those transitions handle a post becoming scheduled/approved, published, or
// cancelled/rejected — and nothing else. Every other way a post stops being scheduled strands its
// media on 'scheduled' for ever:
//
//   • DELETE soft-cancels with a direct db.update that never propagates at all.
//   • A scheduled post sent back for changes goes to pending_approval / draft / in_review, none of
//     which the propagation handles.
//   • 'missed' is handled nowhere.
//   • Replacing a post's media leaves the old asset attached to nothing, still marked scheduled.
//
// So My Content showed media as "Scheduled" that no scheduled post referenced, disagreeing with the
// Calendar and Review Queue about the same posts. The fix derives the displayed status from live
// rows via isScheduleActive — the Calendar's own rule — so there is no transition left to miss.
//
// Run:  npx tsx tests/my-content-status.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { deriveAssetStatus, type AssetUsage } from '../netlify/functions/content-assets';
import { SCHEDULE_ACTIVE_STATUSES, SCHEDULE_INACTIVE_STATUSES, isScheduleActive } from '../src/config/post-status';

let passed = 0, total = 0;
function check(name: string, fn: () => void) {
    total++;
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { console.log(`  ✗ ${name}\n    ${(e as Error).message}`); process.exitCode = 1; }
}

const use = (status: string, over: Partial<AssetUsage> = {}): AssetUsage =>
    ({ id: 1, platform: 'instagram', publishDate: new Date(), status, assistantId: null, assistantName: null, ...over });

console.log('\nmy content asset status\n');

// ── The reported bug, one case per leak ─────────────────────────────────────────────────────────
check('a stranded "scheduled" asset whose post was DELETED reads as pending', () => {
    // The post is soft-cancelled; the DELETE branch never propagated, so the row still says
    // 'scheduled'. What matters is that no live post uses it.
    assert.strictEqual(deriveAssetStatus('scheduled', [use('cancelled')]), 'pending');
});

check('a post sent BACK for changes releases its media', () => {
    for (const back of ['pending_approval', 'draft', 'in_review']) {
        assert.strictEqual(deriveAssetStatus('scheduled', [use(back)]), 'pending',
            `a post at '${back}' has no live schedule, so its media is not scheduled either`);
    }
});

check('a missed post does not hold its media for ever', () => {
    assert.strictEqual(deriveAssetStatus('scheduled', [use('missed')]), 'pending');
});

check('media detached from every post falls back to the pending pool', () => {
    assert.strictEqual(deriveAssetStatus('scheduled', []), 'pending',
        'no post references it at all — "Scheduled" is meaningless');
});

// ── Still correct where it was already correct ──────────────────────────────────────────────────
check('a genuinely scheduled post still marks its media scheduled', () => {
    assert.strictEqual(deriveAssetStatus('pending', [use('scheduled')]), 'scheduled');
    assert.strictEqual(deriveAssetStatus('pending', [use('approved')]), 'scheduled');
});

check('published wins over scheduled — it went out', () => {
    assert.strictEqual(deriveAssetStatus('scheduled', [use('published')]), 'posted');
    // Reused across two posts: gone out once, still queued elsewhere. "Posted" is the stronger fact.
    assert.strictEqual(deriveAssetStatus('scheduled', [use('scheduled'), use('published')]), 'posted');
});

check('history is never demoted, even if the post row has gone', () => {
    assert.strictEqual(deriveAssetStatus('posted', []), 'posted');
});

check('a moderation rejection is not a post state and is never overturned', () => {
    assert.strictEqual(deriveAssetStatus('rejected', [use('scheduled')]), 'rejected');
    assert.strictEqual(deriveAssetStatus('rejected', [use('published')]), 'rejected');
});

check('one live post among several dead ones is enough', () => {
    assert.strictEqual(
        deriveAssetStatus('pending', [use('cancelled'), use('rejected'), use('scheduled')]),
        'scheduled');
});

// ── It really is the Calendar's rule ────────────────────────────────────────────────────────────
check('every schedule-active status marks media scheduled, and no inactive one does', () => {
    for (const s of SCHEDULE_ACTIVE_STATUSES) {
        const expected = s === 'published' ? 'posted' : 'scheduled';
        assert.strictEqual(deriveAssetStatus('pending', [use(s)]), expected,
            `'${s}' is on the Calendar, so its media must not read as pending`);
    }
    for (const s of SCHEDULE_INACTIVE_STATUSES) {
        assert.strictEqual(deriveAssetStatus('pending', [use(s)]), 'pending',
            `'${s}' is NOT on the Calendar, so its media must not read as scheduled`);
    }
});

check('the two lists agree with isScheduleActive itself', () => {
    // Guards the derivation against the config drifting underneath it.
    for (const s of SCHEDULE_ACTIVE_STATUSES) assert.ok(isScheduleActive(s));
    for (const s of SCHEDULE_INACTIVE_STATUSES) assert.ok(!isScheduleActive(s));
});

// ── The wiring ──────────────────────────────────────────────────────────────────────────────────
check('the listing derives the status instead of trusting the column', () => {
    const src = readFileSync(path.join(import.meta.dirname, '..', 'netlify/functions/content-assets.ts'), 'utf8');
    assert.ok(!/const bucket = grouped\[r\.status\] \?\? \[\];/.test(src),
        'grouping straight off the stored column is the bug');
    assert.match(src, /const status = deriveAssetStatus\(r\.status, usage\)/);
    assert.match(src, /isScheduleActive/, 'and it must use the Calendar\'s rule, not a local list');
});

check('the delete warning still lists only work that would BREAK', () => {
    // The usage lookup now includes published posts so "posted" can be derived — but a published
    // post is finished with, so it must not turn up in the "this asset is in use" warning.
    const src = readFileSync(path.join(import.meta.dirname, '..', 'netlify/functions/content-assets.ts'), 'utf8');
    assert.match(src, /usedInPosts: usage\.filter\(u => ACTIVE_POST_STATUSES\.includes\(u\.status\)\)/);
});

// ── The "Post #N" badge ─────────────────────────────────────────────────────────────────────────
// content_assets.scheduled_post_id is written once and never cleared, so it outlived the post it
// named: a stale id sat under the Scheduled chip and in the delete warning, pointing at a post that
// had been cancelled, sent back for changes, or given different media. The served value is now
// found the same way the status is, so the two can never disagree.

/** The endpoint's rule for which post the badge names. */
function livePostFor(usage: AssetUsage[]) {
    return usage.find(u => u.status === 'published')
        ?? usage.find(u => isScheduleActive(u.status))
        ?? null;
}

check('the badge names the post that actually holds the media', () => {
    const usage = [use('cancelled', { id: 11 }), use('scheduled', { id: 22 })];
    assert.strictEqual(livePostFor(usage)?.id, 22, 'the cancelled post must not be named');
});

check('no live post means no badge at all, rather than a stale number', () => {
    assert.strictEqual(livePostFor([use('cancelled', { id: 11 })]), null);
    assert.strictEqual(livePostFor([]), null);
});

check('badge and status are found the same way, so they cannot disagree', () => {
    for (const s of [...SCHEDULE_ACTIVE_STATUSES, ...SCHEDULE_INACTIVE_STATUSES]) {
        const usage = [use(s, { id: 9 })];
        const status = deriveAssetStatus('pending', usage);
        const live = livePostFor(usage);
        if (status === 'pending') assert.strictEqual(live, null, `'${s}' is not live, so nothing to name`);
        else assert.strictEqual(live?.id, 9, `'${s}' gave status '${status}' but named no post`);
    }
});

check('the endpoint serves the derived id, not the stored column', () => {
    const src = readFileSync(path.join(import.meta.dirname, '..', 'netlify/functions/content-assets.ts'), 'utf8');
    assert.match(src, /scheduledPostId: livePost\?\.id \?\? null/,
        'the served id must come from live usage');
    assert.match(src, /const livePost = usage\.find\(u => u\.status === 'published'\)/);
});

// ── The source pills ────────────────────────────────────────────────────────────────────────────
/** The real _sourceInfo, lifted out of my-content.js. */
function sourceInfo(asset: Record<string, unknown>): { label: string } | null {
    const src = readFileSync(path.join(import.meta.dirname, '..', 'my-content.js'), 'utf8');
    const i = src.indexOf('function _sourceInfo(');
    let d = 0, body = '';
    for (let j = src.indexOf('{', i); j < src.length; j++) {
        if (src[j] === '{') d++;
        else if (src[j] === '}') { d--; if (d === 0) { body = src.slice(i, j + 1); break; } }
    }
    return new Function(`${body}; return _sourceInfo;`)()(asset);
}

check('the pills name the assistant when we know it', () => {
    assert.strictEqual(sourceInfo({ assetType: 'image', provider: 'fal', assistantName: 'Ava' })?.label,
        'Generated by Ava');
    assert.strictEqual(sourceInfo({ assetType: 'image', provider: 'pexels', assistantName: 'Ava' })?.label,
        'Sourced by Ava');
});

check('and fall back to the generic wording when we do not', () => {
    // The name comes from the posts using the asset, so media on no post genuinely has none.
    // "Generated by undefined" would be worse than the generic label it replaced.
    for (const name of [null, undefined, '', '   ']) {
        assert.strictEqual(sourceInfo({ assetType: 'image', provider: 'fal', assistantName: name })?.label,
            'AI Generated', `a ${JSON.stringify(name)} name must not reach the badge`);
        assert.strictEqual(sourceInfo({ assetType: 'image', provider: 'pexels', assistantName: name })?.label,
            'Sourced by Assistant');
    }
});

check('Canva and your own uploads are untouched by the rename', () => {
    assert.strictEqual(sourceInfo({ assetType: 'image', provider: 'canva', assistantName: 'Ava' })?.label, 'From Canva');
    assert.strictEqual(sourceInfo({ assetType: 'image', provider: null, assistantName: 'Ava' })?.label, 'Your Upload');
    assert.strictEqual(sourceInfo({ assetType: 'link', provider: 'fal', assistantName: 'Ava' }), null);
});

console.log(`\n${passed} passed${total - passed ? `, ${total - passed} failed` : ''}\n`);
if (passed !== total) process.exit(1);
